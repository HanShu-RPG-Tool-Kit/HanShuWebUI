/**
 * 语言（locale）总表 + 语言标签格式化接口。
 *
 * 标签统一为「语言_地区」的小写下划线形式（如 `zh_cn`、`en_us`），
 * 与项目既有约定保持一致：`*.lines.<locale>.lang`、`*.lines.<locale>.voice`、
 * `assets/<locale>/voice/...`、`<ns>/lines/lang/<locale>.lang`。
 *
 * 命名约定（三套名字都留着，用途不同）：
 * - `nativeName`  本国语言写法（English / Deutsch (Österreich) / 日本語），**界面显示用**
 * - `englishName` 英文名，**排序依据**（跨文字系统稳定）
 * - `chineseName` 中文名，仅作数据/提示用（下拉项 title）
 *
 * 对外主要接口：
 * - `formatLocaleTag(raw)`  把任意写法（`zh-CN`、`ZH_cn`…）格式化成 `zh_cn`
 * - `findLocale(tag)`       查表；`resolveLocale(tag)` 带兜底，未知标签也能显示
 * - `COMMON_LOCALES`        常用语言（下拉框置顶）
 * - `ALL_LOCALES`           全部语言，已按英文名 A→Z 排序
 * - `getLocaleGroups()`     下拉框分组数据：首组带「常用语言」文本标签
 */

export type LocaleEntry = {
  /** 规范化标签，如 `zh_cn` */
  tag: string
  /** 本国语言写法，界面显示用 */
  nativeName: string
  /** 英文名，排序依据 */
  englishName: string
  /** 中文名 */
  chineseName: string
}

/** 默认语言标签 */
export const DEFAULT_LOCALE_TAG = 'zh_cn'

/** 常用语言：下拉框「常用语言」标签下的三个 */
export const COMMON_LOCALE_TAGS: readonly string[] = [
  'zh_cn',
  'en_us',
  'ja_jp',
]

/** 合法标签：`xx` / `xxx`，可带若干 `_region` 段，全小写 */
const LOCALE_TAG_RE = /^[a-z]{2,3}(?:_[a-z0-9]{2,8})*$/

/**
 * 语言标签格式化。
 * `zh-CN` / `zh_cn` / ` ZH_CN ` → `zh_cn`；无法识别时返回空串。
 */
export function formatLocaleTag(raw: string): string {
  const tag = raw.trim().toLowerCase().replace(/-/g, '_')
  return LOCALE_TAG_RE.test(tag) ? tag : ''
}

/** 是否为合法标签（已格式化形式） */
export function isValidLocaleTag(tag: string): boolean {
  return LOCALE_TAG_RE.test(tag)
}

/** 内置语言总表：`[标签, 中文名, 英文名, 本国语言名]`（离线静态表，可随时增删） */
const RAW_LOCALES: ReadonlyArray<readonly [string, string, string, string]> = [
  ['af_za', '南非荷兰语', 'Afrikaans', 'Afrikaans'],
  ['am_et', '阿姆哈拉语', 'Amharic', 'አማርኛ'],
  ['ar_sa', '阿拉伯语', 'Arabic', 'العربية'],
  ['az_az', '阿塞拜疆语', 'Azerbaijani', 'azərbaycan dili'],
  ['ba_ru', '巴什基尔语', 'Bashkir', 'башҡортса'],
  ['be_by', '白俄罗斯语', 'Belarusian', 'беларуская'],
  ['bg_bg', '保加利亚语', 'Bulgarian', 'български'],
  ['bn_bd', '孟加拉语', 'Bengali', 'বাংলা'],
  ['bo_cn', '藏语', 'Tibetan', 'བོད་ཡིག'],
  ['br_fr', '布列塔尼语', 'Breton', 'brezhoneg'],
  ['bs_ba', '波斯尼亚语', 'Bosnian', 'bosanski'],
  ['ca_es', '加泰罗尼亚语', 'Catalan', 'català'],
  ['co_fr', '科西嘉语', 'Corsican', 'corsu'],
  ['cs_cz', '捷克语', 'Czech', 'čeština'],
  ['cy_gb', '威尔士语', 'Welsh', 'Cymraeg'],
  ['da_dk', '丹麦语', 'Danish', 'dansk'],
  ['de_de', '德语（德国）', 'German (Germany)', 'Deutsch (Deutschland)'],
  ['de_at', '德语（奥地利）', 'German (Austria)', 'Deutsch (Österreich)'],
  ['dv_mv', '迪维希语', 'Dhivehi', 'ދިވެހި'],
  ['ee_gh', '埃维语', 'Ewe', 'Eʋegbe'],
  ['el_gr', '希腊语', 'Greek', 'Ελληνικά'],
  ['en_us', '英语（美国）', 'English (United States)', 'English (United States)'],
  ['en_gb', '英语（英国）', 'English (United Kingdom)', 'English (United Kingdom)'],
  ['eo', '世界语', 'Esperanto', 'Esperanto'],
  ['es_es', '西班牙语（西班牙）', 'Spanish (Spain)', 'español (España)'],
  ['es_mx', '西班牙语（墨西哥）', 'Spanish (Mexico)', 'español (México)'],
  ['es_ar', '西班牙语（阿根廷）', 'Spanish (Argentina)', 'español (Argentina)'],
  ['et_ee', '爱沙尼亚语', 'Estonian', 'eesti'],
  ['eu_es', '巴斯克语', 'Basque', 'euskara'],
  ['fa_ir', '波斯语', 'Persian', 'فارسی'],
  ['fi_fi', '芬兰语', 'Finnish', 'suomi'],
  ['fo_fo', '法罗语', 'Faroese', 'føroyskt'],
  ['fr_fr', '法语（法国）', 'French (France)', 'français (France)'],
  ['fr_ca', '法语（加拿大）', 'French (Canada)', 'français (Canada)'],
  ['fy_nl', '西弗里西语', 'Western Frisian', 'Frysk'],
  ['ga_ie', '爱尔兰语', 'Irish', 'Gaeilge'],
  ['gd_gb', '苏格兰盖尔语', 'Scottish Gaelic', 'Gàidhlig'],
  ['gl_es', '加利西亚语', 'Galician', 'galego'],
  ['gn_py', '瓜拉尼语', 'Guarani', "Avañe'ẽ"],
  ['gu_in', '古吉拉特语', 'Gujarati', 'ગુજરાતી'],
  ['ha_ng', '豪萨语', 'Hausa', 'Hausa'],
  ['he_il', '希伯来语', 'Hebrew', 'עברית'],
  ['hi_in', '印地语', 'Hindi', 'हिन्दी'],
  ['hr_hr', '克罗地亚语', 'Croatian', 'hrvatski'],
  ['ht_ht', '海地克里奥尔语', 'Haitian Creole', 'Kreyòl ayisyen'],
  ['hu_hu', '匈牙利语', 'Hungarian', 'magyar'],
  ['hy_am', '亚美尼亚语', 'Armenian', 'հայերեն'],
  ['id_id', '印度尼西亚语', 'Indonesian', 'Indonesia'],
  ['ig_ng', '伊博语', 'Igbo', 'Igbo'],
  ['io', '伊多语', 'Ido', 'Ido'],
  ['is_is', '冰岛语', 'Icelandic', 'íslenska'],
  ['it_it', '意大利语', 'Italian', 'italiano'],
  ['iu_ca', '因纽特语', 'Inuktitut', 'ᐃᓄᒃᑎᑐᑦ'],
  ['ja_jp', '日语', 'Japanese', '日本語'],
  ['jv_id', '爪哇语', 'Javanese', 'Basa Jawa'],
  ['ka_ge', '格鲁吉亚语', 'Georgian', 'ქართული'],
  ['kk_kz', '哈萨克语', 'Kazakh', 'қазақ тілі'],
  ['km_kh', '高棉语', 'Khmer', 'ខ្មែរ'],
  ['kn_in', '卡纳达语', 'Kannada', 'ಕನ್ನಡ'],
  ['ko_kr', '韩语', 'Korean', '한국어'],
  ['ku_tr', '库尔德语', 'Kurdish', 'Kurdî'],
  ['ky_kg', '吉尔吉斯语', 'Kyrgyz', 'кыргызча'],
  ['la', '拉丁语', 'Latin', 'Latina'],
  ['lb_lu', '卢森堡语', 'Luxembourgish', 'Lëtzebuergesch'],
  ['ln_cd', '林加拉语', 'Lingala', 'Lingála'],
  ['lo_la', '老挝语', 'Lao', 'ລາວ'],
  ['lt_lt', '立陶宛语', 'Lithuanian', 'lietuvių'],
  ['lv_lv', '拉脱维亚语', 'Latvian', 'latviešu'],
  ['mg_mg', '马达加斯加语', 'Malagasy', 'Malagasy'],
  ['mi_nz', '毛利语', 'Maori', 'te reo Māori'],
  ['mk_mk', '马其顿语', 'Macedonian', 'македонски'],
  ['ml_in', '马拉雅拉姆语', 'Malayalam', 'മലയാളം'],
  ['mn_mn', '蒙古语', 'Mongolian', 'монгол'],
  ['mr_in', '马拉地语', 'Marathi', 'मराठी'],
  ['ms_my', '马来语', 'Malay', 'Bahasa Melayu'],
  ['mt_mt', '马耳他语', 'Maltese', 'Malti'],
  ['my_mm', '缅甸语', 'Burmese', 'မြန်မာဘာသာ'],
  ['nb_no', '挪威语（书面）', 'Norwegian Bokmål', 'norsk bokmål'],
  ['ne_np', '尼泊尔语', 'Nepali', 'नेपाली'],
  ['nl_nl', '荷兰语', 'Dutch', 'Nederlands'],
  ['nn_no', '挪威语（新诺斯克）', 'Norwegian Nynorsk', 'nynorsk'],
  ['ny_mw', '齐切瓦语', 'Chichewa', 'Chichewa'],
  ['om_et', '奥罗莫语', 'Oromo', 'Afaan Oromoo'],
  ['or_in', '奥里亚语', 'Odia', 'ଓଡ଼ିଆ'],
  ['os_ge', '奥塞梯语', 'Ossetian', 'ирон æвзаг'],
  ['pa_in', '旁遮普语', 'Punjabi', 'ਪੰਜਾਬੀ'],
  ['pl_pl', '波兰语', 'Polish', 'polski'],
  ['ps_af', '普什图语', 'Pashto', 'پښتو'],
  ['pt_br', '葡萄牙语（巴西）', 'Portuguese (Brazil)', 'português (Brasil)'],
  ['pt_pt', '葡萄牙语（葡萄牙）', 'Portuguese (Portugal)', 'português (Portugal)'],
  ['qu_pe', '克丘亚语', 'Quechua', 'Runasimi'],
  ['rm_ch', '罗曼什语', 'Romansh', 'rumantsch'],
  ['ro_ro', '罗马尼亚语', 'Romanian', 'română'],
  ['ru_ru', '俄语', 'Russian', 'русский'],
  ['rw_rw', '卢旺达语', 'Kinyarwanda', 'Ikinyarwanda'],
  ['sa', '梵语', 'Sanskrit', 'संस्कृतम्'],
  ['sd_pk', '信德语', 'Sindhi', 'سنڌي'],
  ['se_no', '北萨米语', 'Northern Sami', 'davvisámegiella'],
  ['si_lk', '僧伽罗语', 'Sinhala', 'සිංහල'],
  ['sk_sk', '斯洛伐克语', 'Slovak', 'slovenčina'],
  ['sl_si', '斯洛文尼亚语', 'Slovenian', 'slovenščina'],
  ['sm_ws', '萨摩亚语', 'Samoan', 'Gagana Samoa'],
  ['sn_zw', '绍纳语', 'Shona', 'chiShona'],
  ['so_so', '索马里语', 'Somali', 'Soomaali'],
  ['sq_al', '阿尔巴尼亚语', 'Albanian', 'Shqip'],
  ['sr_rs', '塞尔维亚语', 'Serbian', 'српски'],
  ['st_za', '南索托语', 'Southern Sotho', 'Sesotho'],
  ['su_id', '巽他语', 'Sundanese', 'Basa Sunda'],
  ['sv_se', '瑞典语', 'Swedish', 'svenska'],
  ['sw_ke', '斯瓦希里语', 'Swahili', 'Kiswahili'],
  ['ta_in', '泰米尔语', 'Tamil', 'தமிழ்'],
  ['te_in', '泰卢固语', 'Telugu', 'తెలుగు'],
  ['tg_tj', '塔吉克语', 'Tajik', 'тоҷикӣ'],
  ['th_th', '泰语', 'Thai', 'ไทย'],
  ['ti_et', '提格里尼亚语', 'Tigrinya', 'ትግርኛ'],
  ['tk_tm', '土库曼语', 'Turkmen', 'türkmençe'],
  ['tl_ph', '菲律宾语', 'Filipino', 'Filipino'],
  ['tn_za', '茨瓦纳语', 'Tswana', 'Setswana'],
  ['to_to', '汤加语', 'Tongan', 'lea fakatonga'],
  ['tr_tr', '土耳其语', 'Turkish', 'Türkçe'],
  ['ts_za', '聪加语', 'Tsonga', 'Xitsonga'],
  ['tt_ru', '鞑靼语', 'Tatar', 'татарча'],
  ['ug_cn', '维吾尔语', 'Uyghur', 'ئۇيغۇرچە'],
  ['uk_ua', '乌克兰语', 'Ukrainian', 'українська'],
  ['ur_pk', '乌尔都语', 'Urdu', 'اردو'],
  ['uz_uz', '乌兹别克语', 'Uzbek', "o'zbekcha"],
  ['vi_vn', '越南语', 'Vietnamese', 'Tiếng Việt'],
  ['xh_za', '科萨语', 'Xhosa', 'isiXhosa'],
  ['yi_il', '意第绪语', 'Yiddish', 'ייִדיש'],
  ['yo_ng', '约鲁巴语', 'Yoruba', 'Yorùbá'],
  ['zh_cn', '简体中文', 'Chinese (Simplified)', '简体中文'],
  ['zh_tw', '繁体中文（台湾）', 'Chinese (Traditional, Taiwan)', '繁體中文（台灣）'],
  ['zh_hk', '繁体中文（香港）', 'Chinese (Traditional, Hong Kong)', '繁體中文（香港）'],
  ['zu_za', '祖鲁语', 'Zulu', 'isiZulu'],
]

function toEntry([tag, chineseName, englishName, nativeName]: readonly [
  string,
  string,
  string,
  string,
]): LocaleEntry {
  return { tag, nativeName, englishName, chineseName }
}

/** 全表按英文名 A→Z（跨文字系统稳定，不随脚本变化） */
const byEnglishName = (a: LocaleEntry, b: LocaleEntry) =>
  a.englishName.localeCompare(b.englishName, 'en') || a.tag.localeCompare(b.tag)

const LOCALE_INDEX = new Map<string, LocaleEntry>(
  RAW_LOCALES.map((raw) => {
    const entry = toEntry(raw)
    return [entry.tag, entry]
  }),
)

/** 常用语言条目（按 `COMMON_LOCALE_TAGS` 顺序；表里没有的自动跳过） */
export const COMMON_LOCALES: readonly LocaleEntry[] = COMMON_LOCALE_TAGS.map(
  (tag) => LOCALE_INDEX.get(tag),
).filter((entry): entry is LocaleEntry => Boolean(entry))

/** 全部语言，按英文名排序 */
export const ALL_LOCALES: readonly LocaleEntry[] = [
  ...LOCALE_INDEX.values(),
].sort(byEnglishName)

/** 查表；未收录返回 `undefined` */
export function findLocale(tag: string): LocaleEntry | undefined {
  return LOCALE_INDEX.get(formatLocaleTag(tag))
}

/** 查表并兜底：未收录的标签也能拿到一个可显示的条目 */
export function resolveLocale(tag: string): LocaleEntry {
  const formatted = formatLocaleTag(tag) || DEFAULT_LOCALE_TAG
  return (
    LOCALE_INDEX.get(formatted) ?? {
      tag: formatted,
      nativeName: formatted,
      englishName: formatted,
      chineseName: formatted,
    }
  )
}

/** 界面显示的标签：本国语言名；未收录时回落到标签本身 */
export function getLocaleLabel(tag: string): string {
  return resolveLocale(tag).nativeName
}

/** 下拉框分组：首组带「常用语言」文本标签，其后是全部语言（按英文名） */
export type LocaleGroup = {
  /** `null` 表示不渲染文本标签，只作为一组 */
  label: string | null
  items: readonly LocaleEntry[]
}

export function getLocaleGroups(): LocaleGroup[] {
  return [
    { label: '常用语言', items: COMMON_LOCALES },
    { label: null, items: ALL_LOCALES },
  ]
}
