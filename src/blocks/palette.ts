import { BlockState } from '../voxel/voxels.js';
import { compound, type CompoundValue } from '../nbt/nbt.js';
import { defaultProps } from './registry.js';

/**
 * One block-state palette entry (chunk sections and structure files) as prismarine-nbt hands
 * it back. Up to 26.2 every entry is a compound {Name, Properties?}. From 26.3 it is
 * {id, properties?}, and a block in its default state is stored as just its name: a bare
 * string when the whole list is strings, or wrapped as {"": name} inside a list that also
 * holds compounds (NBT lists are homogeneous, so mixed lists wrap their non-compound items).
 */
export type PaletteEntry = CompoundValue | string;

function entryName(entry: CompoundValue): string {
  const tag = entry.Name ?? entry.id;
  if (!tag || typeof tag.value !== 'string') throw new Error('NBT: palette entry has neither "Name" nor "id"');
  return tag.value;
}

/**
 * Decode a palette entry into a full block state. Properties the entry leaves out are filled
 * from the block's default state, so a compacted 26.3 entry ("minecraft:powered_rail") reads
 * the same as the full one 26.2 wrote (powered_rail[powered=false,shape=north_south,...]).
 */
export function stateFromPalette(entry: PaletteEntry): BlockState {
  let name: string;
  const props: Record<string, string> = {};
  if (typeof entry === 'string') name = entry;
  else if (entry[''] && typeof entry[''].value === 'string') name = entry[''].value;
  else {
    name = entryName(entry);
    const p = compound(entry, 'Properties') ?? compound(entry, 'properties');
    if (p) for (const [k, v] of Object.entries(p)) props[k] = String(v.value);
  }
  if (!name.includes(':')) name = `minecraft:${name}`;
  return new BlockState(name, { ...defaultProps(name), ...props });
}
