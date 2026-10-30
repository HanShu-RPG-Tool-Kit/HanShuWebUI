/** Resource formats and storage categories. Explorer views are deliberately separate. */
export const RESOURCE_TYPES = [
  { id:'hs', ext:'.hs', directory:'src/hanshu', category:'hanshu' },
  { id:'char', ext:'.char', directory:'src/character', category:'character' },
  { id:'py', ext:'.py', directory:'src/script/common', category:'script' },
  { id:'quest', ext:'.quest', directory:'src/quest', category:'quest' },
  { id:'level', ext:'.level', directory:'src/level', category:'level' },
  { id:'nav', ext:'.nav', directory:'src/navigator', category:'level' },
  { id:'item', ext:'.item', directory:'src/items', category:'items' },
  { id:'entity', ext:'.entity', directory:'src/entities', category:'entities' },
  { id:'kit', ext:'.kit', directory:'src/gift', category:'gift' },
  { id:'actor', ext:'.actor', directory:'src/actors', category:'actor' },
  { id:'shop', ext:'.shop', directory:'src/shop', category:'shop' },
  { id:'md', ext:'.md', directory:'meta/docs', category:'meta' },
  { id:'tts', ext:'.tts', directory:'meta/voice', category:'meta' },
  { id:'ttsservice', ext:'.ttsservice', directory:'meta/voice/service', category:'meta' },
] as const
export type ResourceTypeId = typeof RESOURCE_TYPES[number]['id']
export const resourceTypeForExtension = (ext:string) => RESOURCE_TYPES.find(type=>type.ext===ext.toLowerCase())
export const resourceNameKey = (name:string) => name.normalize('NFC').toLowerCase()
/** Saved formats and convertible import formats are different capabilities. */
export const GAMEPLAY_CATEGORIES = {
  script:{name:'脚本',types:['py'],imports:['.py']},
  quest:{name:'任务',types:['quest'],imports:['.quest','.json']},
  actor:{name:'演员',types:['actor'],imports:['.actor']},
  reputation:{name:'声誉',types:[],imports:[]},
  level:{name:'地图',types:['level','nav'],imports:['.level','.nav','.json']},
  shop:{name:'商店',types:['shop'],imports:['.shop']},
  gift:{name:'礼包',types:['kit'],imports:['.kit']},
  items:{name:'物品库',types:['item'],imports:['.item','.itemstack','.json']},
  entities:{name:'实体库',types:['entity'],imports:['.entity']},
} as const satisfies Record<string,{name:string;types:readonly ResourceTypeId[];imports:readonly string[]}>
export type GameplayCategoryId = keyof typeof GAMEPLAY_CATEGORIES
export function categoryExtensions(id:GameplayCategoryId):string[]{
  return GAMEPLAY_CATEGORIES[id].types.map(type=>RESOURCE_TYPES.find(def=>def.id===type)!.ext)
}
