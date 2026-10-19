import { describe, it, expect } from 'vitest';
import minecraftData from 'minecraft-data';
import { stateFromPalette, type PaletteEntry } from '../../src/blocks/palette.js';
import { defaultProps, validateState, REGISTRY_MC_VERSION } from '../../src/blocks/registry.js';
import { BlockState } from '../../src/voxel/voxels.js';
import { T, parseNbt, writeNbtRaw, listOf, type CompoundValue, type NbtTag } from '../../src/nbt/nbt.js';

const props = (o: Record<string, string>): CompoundValue => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, T.string(v)]));
const text = (e: PaletteEntry) => stateFromPalette(e).toString();

/** A palette list written and parsed back, so entries have exactly the shape prismarine-nbt hands the readers. */
async function roundTrip(list: NbtTag): Promise<PaletteEntry[]> {
  const root = T.comp({ palette: list }, '');
  return listOf((await parseNbt(writeNbtRaw(root))).value, 'palette') as PaletteEntry[];
}

const RAIL_DEFAULT = 'minecraft:powered_rail[powered=false,shape=north_south,waterlogged=false]';

describe('stateFromPalette', () => {
  it('reads the pre-26.3 {Name, Properties} shape', async () => {
    const [stone, stairs] = await roundTrip(
      T.list(
        T.comp([
          { Name: T.string('minecraft:stone') },
          { Name: T.string('minecraft:oak_stairs'), Properties: T.comp(props({ facing: 'east', half: 'top', shape: 'straight', waterlogged: 'false' })) },
        ]),
      ),
    );
    expect(text(stone)).toBe('minecraft:stone');
    expect(text(stairs)).toBe('minecraft:oak_stairs[facing=east,half=top,shape=straight,waterlogged=false]');
  });

  it('reads the 26.3 {id, properties} shape', async () => {
    const [stairs] = await roundTrip(T.list(T.comp([{ id: T.string('minecraft:oak_stairs'), properties: T.comp(props({ facing: 'west', half: 'bottom', shape: 'outer_left', waterlogged: 'true' })) }])));
    expect(text(stairs)).toBe('minecraft:oak_stairs[facing=west,half=bottom,shape=outer_left,waterlogged=true]');
  });

  it('reads a 26.3 palette of bare names', async () => {
    const entries = await roundTrip(T.list(T.string(['minecraft:air', 'minecraft:stone', 'minecraft:powered_rail'])));
    expect(entries.map(text)).toEqual(['minecraft:air', 'minecraft:stone', RAIL_DEFAULT]);
  });

  it('reads a 26.3 mixed palette, where bare names are wrapped as {"": name}', async () => {
    const entries = await roundTrip(
      T.list(
        T.comp([
          { '': T.string('minecraft:stone') },
          { id: T.string('minecraft:powered_rail'), properties: T.comp(props({ powered: 'true', shape: 'east_west', waterlogged: 'false' })) },
          { '': T.string('minecraft:powered_rail') },
        ]),
      ),
    );
    expect(entries.map(text)).toEqual(['minecraft:stone', 'minecraft:powered_rail[powered=true,shape=east_west,waterlogged=false]', RAIL_DEFAULT]);
  });

  it('namespaces a bare name and rejects an entry with no name at all', () => {
    expect(text('stone')).toBe('minecraft:stone');
    expect(() => stateFromPalette({ Properties: T.comp({}) })).toThrow(/neither "Name" nor "id"/);
  });
});

describe('default states', () => {
  it('fills a compacted default-state entry with its properties', () => {
    expect(text('minecraft:powered_rail')).toBe(RAIL_DEFAULT);
    expect(text({ id: T.string('minecraft:oak_leaves') })).toBe('minecraft:oak_leaves[distance=7,persistent=false,waterlogged=false]');
    expect(text({ '': T.string('minecraft:brown_mushroom_block') })).toBe('minecraft:brown_mushroom_block[down=true,east=true,north=true,south=true,up=true,west=true]');
  });

  it('fills only the properties an entry leaves out', () => {
    expect(text({ id: T.string('minecraft:powered_rail'), properties: T.comp(props({ powered: 'true' })) })).toBe('minecraft:powered_rail[powered=true,shape=north_south,waterlogged=false]');
  });

  it('compares equal to the same state written in full', () => {
    const full = stateFromPalette({ Name: T.string('minecraft:powered_rail'), Properties: T.comp(props({ powered: 'false', shape: 'north_south', waterlogged: 'false' })) });
    expect(stateFromPalette('minecraft:powered_rail').equals(full)).toBe(true);
    expect(stateFromPalette('minecraft:powered_rail').equals(BlockState.parse('powered_rail'))).toBe(false);
  });

  it('leaves blocks the registry does not know as they are', () => {
    expect(text('create:shaft')).toBe('create:shaft');
    expect(text('minecraft:block_from_the_future')).toBe('minecraft:block_from_the_future');
  });

  it('decodes a complete, valid default state for every block in the registry', () => {
    for (const b of minecraftData(REGISTRY_MC_VERSION).blocksArray) {
      const p = defaultProps(`minecraft:${b.name}`);
      expect(Object.keys(p).sort(), b.name).toEqual((b.states ?? []).map((s) => s.name).sort());
      expect(validateState(new BlockState(b.name, { ...p })), b.name).toBeUndefined();
    }
  });
});
