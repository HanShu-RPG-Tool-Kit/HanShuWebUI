/** Resource formats and storage categories. Explorer views are deliberately separate. */
export const RESOURCE_TYPES = [
  { id:'hs', ext:'.hs', directory:'src/hanshu', category:'hanshu' },
  { id:'char', ext:'.char', directory:'src/character', category:'character' },
  { id:'js', ext:'.js', directory:'src/script/common', category:'script' },
  { id:'quest', ext:'.quest', directory:'src/quest', category:'quest' },
  { id:'level', ext:'.level', directory:'src/level', category:'level' },
  { id:'nav', ext:'.nav', directory:'src/navigator', category:'level' },
  { id:'item', ext:'.item', directory:'src/items', category:'items' },
  { id:'entity', ext:'.entity', directory:'src/entities', category:'entities' },
  { id:'kit', ext:'.kit', directory:'src/gift', category:'gift' },
  { id:'actor', ext:'.actor', directory:'src/actors', category:'actor' },
  { id:'rep', ext:'.rep', directory:'src/reputations', category:'reputation' },
  { id:'shop', ext:'.shop', directory:'src/shop', category:'shop' },
  { id:'bossbar', ext:'.bossbar', directory:'src/bossbars', category:'bossbar' },
  { id:'md', ext:'.md', directory:'meta/docs', category:'meta' },
  { id:'tts', ext:'.tts', directory:'meta/voice', category:'meta' },
  { id:'ttsservice', ext:'.ttsservice', directory:'meta/voice/service', category:'meta' },
] as const
export type ResourceTypeId = typeof RESOURCE_TYPES[number]['id']
export const resourceTypeForExtension = (ext:string) => RESOURCE_TYPES.find(type=>type.ext===ext.toLowerCase())
export const resourceNameKey = (name:string) => name.normalize('NFC').toLowerCase()
/** Saved formats and convertible import formats are different capabilities. */
export const GAMEPLAY_CATEGORIES = {
  script:{name:'脚本',types:['js'],imports:['.js']},
  quest:{name:'任务',types:['quest'],imports:['.quest','.json']},
  actor:{name:'演员',types:['actor'],imports:['.actor']},
  reputation:{name:'声誉',types:['rep'],imports:['.rep']},
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
/**
 * 视听效果工作区业务分类；与游戏性分类并列，不写入 GAMEPLAY_CATEGORIES。
 * `icon` 对应 `explorerIcons` 的 kind；尚无原生格式的分类 `types` / `imports` 为空，仅作顶层占位。
 */
export const AUDIOVISUAL_CATEGORIES = {
  ui:{name:'用户界面',icon:'av-ui',types:[],imports:[]},
  bossbar:{name:'BOSS血条',icon:'bossbar',types:['bossbar'],imports:['.bossbar']},
  overhead:{name:'头顶标记',icon:'av-overhead',types:[],imports:[]},
  appearance:{name:'人类外观组件',icon:'av-appearance',types:[],imports:[]},
  action:{name:'人类动作',icon:'av-action',types:[],imports:[]},
  expression:{name:'人类表情',icon:'av-expression',types:[],imports:[]},
  cutscene:{name:'过场动画',icon:'av-cutscene',types:[],imports:[]},
  prop:{name:'物品',icon:'av-prop',types:[],imports:[]},
  decoration:{name:'建筑装饰',icon:'av-decoration',types:[],imports:[]},
  particle:{name:'粒子',icon:'av-particle',types:[],imports:[]},
  fog:{name:'雾',icon:'av-fog',types:[],imports:[]},
  skybox:{name:'天空盒',icon:'av-skybox',types:[],imports:[]},
  bgm:{name:'背景音乐',icon:'av-bgm',types:[],imports:[]},
  sfx:{name:'音效',icon:'av-sfx',types:[],imports:[]},
  localization:{name:'文本本地化',icon:'av-localization',types:[],imports:[]},
  voiceover:{name:'配音',icon:'av-voiceover',types:[],imports:[]},
} as const satisfies Record<string,{name:string;icon:string;types:readonly ResourceTypeId[];imports:readonly string[]}>
export type AudiovisualCategoryId = keyof typeof AUDIOVISUAL_CATEGORIES
export function audiovisualCategoryExtensions(id:AudiovisualCategoryId):string[]{
  return AUDIOVISUAL_CATEGORIES[id].types.map(type=>RESOURCE_TYPES.find(def=>def.id===type)!.ext)
}
export const AUDIOVISUAL_CATEGORY_ORDER = Object.keys(AUDIOVISUAL_CATEGORIES) as AudiovisualCategoryId[]
/**
 * 剧本工作区业务分类；与物理分组 `STAGEPLAY_WORKSPACE_GROUP_ORDER` 一一对应。
 * 与游戏性 / 视听一样启用共享虚拟文件夹（见 `organizationDomains.ts`）。
 */
export const STAGEPLAY_CATEGORIES = {
  hanshu:{name:'汉书剧本',icon:'hanshu',types:['hs'],imports:['.hs']},
  character:{name:'角色卡',icon:'character',types:['char'],imports:['.char']},
  meta:{name:'创作资料',icon:'markdown',types:['md','tts','ttsservice'],imports:['.md','.tts','.ttsservice']},
} as const satisfies Record<string,{name:string;icon:string;types:readonly ResourceTypeId[];imports:readonly string[]}>
export type StageplayCategoryId = keyof typeof STAGEPLAY_CATEGORIES
