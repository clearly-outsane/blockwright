import { describe, it, expect } from 'vitest';
import { BlockState, VoxelSet } from '../../src/voxel/voxels.js';
import { clipboardFromVoxels } from '../../src/schematic/clipboard.js';
import { readStructure, writeStructure, structureDataVersion, LEGACY_PALETTE_DATA_VERSION } from '../../src/schematic/structure.js';
import { T, parseNbt, writeNbtGz, compound, listOf, num, str, type CompoundValue } from '../../src/nbt/nbt.js';

const st = (s: string) => BlockState.parse(s);

describe('vanilla structure codec', () => {
  it('round-trips blocks, properties and a block entity', async () => {
    const v = new VoxelSet();
    v.set(0, 0, 0, st('stone'));
    v.set(1, 0, 0, st('oak_stairs[facing=north,half=top]'));
    v.set(1, 1, 0, st('air'));
    v.set(0, 0, 2, st('oak_sign[rotation=8]'));
    const sign = T.comp({ front_text: T.comp({ messages: T.list(T.string(['"hi"', '""', '""', '""'])) }) }).value;
    const clip = clipboardFromVoxels(v, 4903, [{ pos: [0, 0, 2], id: 'minecraft:sign', data: sign }]);
    const root = writeStructure(clip);
    const back = readStructure(await parseNbt(writeNbtGz(root)));
    expect(back.size).toEqual([2, 2, 3]);
    expect(back.dataVersion).toBe(4903);
    expect(back.voxels.size).toBe(4);
    // Properties the written state left out come back as the block's defaults.
    expect(back.voxels.get(1, 0, 0)?.toString()).toBe('minecraft:oak_stairs[facing=north,half=top,shape=straight,waterlogged=false]');
    expect(back.voxels.get(1, 1, 0)?.isAir).toBe(true);
    expect(back.blockEntities).toHaveLength(1);
    expect(back.blockEntities[0].id).toBe('minecraft:sign');
    expect(back.blockEntities[0].pos).toEqual([0, 0, 2]);
    const frontText = compound(back.blockEntities[0].data, 'front_text');
    expect(frontText).toBeDefined();
    expect(listOf(frontText!, 'messages')).toEqual(['"hi"', '""', '""', '""']);
    expect(back.source).toBe('structure');
  });
  it('accepts the palettes (plural) variant and empty nbt-less blocks', async () => {
    // Build the nested "list of lists" by hand: T.list(T.list(...)) does not nest correctly
    // (prismarine-nbt's list() builder unwraps its argument's .value directly rather than
    // wrapping it in a new array), so a naive double T.list() call silently loses the inner
    // list's elements once the tag is actually serialized and parsed back.
    const dirtPalette = T.comp([{ Name: T.string('minecraft:dirt') }]);
    const oneList = T.list(dirtPalette);
    const palettesTag = T.list({ type: oneList.type, value: [oneList.value] });
    const root = T.comp(
      {
        size: T.list(T.int([1, 1, 1])),
        palettes: palettesTag,
        blocks: T.list(T.comp([{ state: T.int(0), pos: T.list(T.int([0, 0, 0])) }])),
        entities: T.list(T.comp([])),
        DataVersion: T.int(4903),
      },
      '',
    );
    const clip = readStructure(await parseNbt(writeNbtGz(root)));
    expect(clip.voxels.get(0, 0, 0)?.toCommand()).toBe('dirt');
  });

  it('reads a 26.3 structure palette: {id, properties} and wrapped default states', async () => {
    const root = T.comp(
      {
        size: T.list(T.int([2, 1, 1])),
        palette: T.list(
          T.comp([
            { '': T.string('minecraft:powered_rail') },
            { id: T.string('minecraft:powered_rail'), properties: T.comp({ powered: T.string('true'), shape: T.string('east_west'), waterlogged: T.string('false') }) },
          ]),
        ),
        blocks: T.list(T.comp([{ state: T.int(0), pos: T.list(T.int([0, 0, 0])) }, { state: T.int(1), pos: T.list(T.int([1, 0, 0])) }])),
        entities: T.list(T.comp([])),
        DataVersion: T.int(5023),
      },
      '',
    );
    const clip = readStructure(await parseNbt(writeNbtGz(root)));
    expect(clip.voxels.get(0, 0, 0)?.toString()).toBe('minecraft:powered_rail[powered=false,shape=north_south,waterlogged=false]');
    expect(clip.voxels.get(1, 0, 0)?.toString()).toBe('minecraft:powered_rail[powered=true,shape=east_west,waterlogged=false]');
  });
});

describe('structure DataVersion', () => {
  const rail = () => {
    const v = new VoxelSet();
    v.set(0, 0, 0, st('powered_rail[powered=true,shape=east_west,waterlogged=false]'));
    v.set(1, 0, 0, st('stone'));
    return v;
  };

  it('stamps 26.3+ files with the last version whose palette shape it writes, so the server upgrades them', async () => {
    expect(LEGACY_PALETTE_DATA_VERSION).toBe(4903);
    const root = await parseNbt(writeNbtGz(writeStructure(clipboardFromVoxels(rail(), 5023))));
    expect(num(root.value, 'DataVersion')).toBe(4903);
    // The palette is still the {Name, Properties} shape that 4903 promises.
    const palette = listOf(root.value, 'palette') as CompoundValue[];
    expect(palette.map((e) => str(e, 'Name'))).toEqual(['minecraft:powered_rail', 'minecraft:stone']);
    expect(compound(palette[0], 'Properties')).toEqual({ powered: { type: 'string', value: 'true' }, shape: { type: 'string', value: 'east_west' }, waterlogged: { type: 'string', value: 'false' } });
    expect(palette[1].id).toBeUndefined();
  });

  it("keeps an older server's own version", () => {
    expect(structureDataVersion(4903)).toBe(4903);
    expect(structureDataVersion(4325)).toBe(4325);
    expect(structureDataVersion(5023)).toBe(4903);
    expect(structureDataVersion(9999)).toBe(4903);
    expect(num(writeStructure(clipboardFromVoxels(rail(), 4325)).value, 'DataVersion')).toBe(4325);
  });
});
