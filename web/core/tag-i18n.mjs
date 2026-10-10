/**
 * 标签翻译。
 *
 * 卡上的标签经常是英文 / 日文（从别处导入的卡尤其如此），直接铺在界面上看不懂。
 * 这里就一张本地对照表：认识的显示中文（原文放在 tooltip 里），不认识的原样显示。
 * 想加词条直接往下面这对象里加一行就行，不动别的地方。
 */

const TAG_DICT = {
  // 性格
  tsundere: '傲娇',
  ツンデレ: '傲娇',
  yandere: '病娇',
  ヤンデレ: '病娇',
  kuudere: '冷酷',
  クーデレ: '冷酷',
  dandere: '内向',
  deredere: '热恋',
  himedere: '公主病',
  // 关系 / 身份
  osananajimi: '青梅竹马',
  childhoodfriend: '青梅竹马',
  幼馴染: '青梅竹马',
  onesan: '姐姐系',
  お姉さん: '姐姐系',
  imouto: '妹妹系',
  妹: '妹妹系',
  senpai: '前辈',
  先輩: '前辈',
  sensei: '老师',
  先生: '老师',
  maid: '女仆',
  メイド: '女仆',
  idol: '偶像',
  アイドル: '偶像',
  vampire: '吸血鬼',
  ヴァンパイア: '吸血鬼',
  elf: '精灵',
  エルフ: '精灵',
  witch: '魔女',
  魔女: '魔女',
  princess: '公主',
  姫: '公主',
  knight: '骑士',
  騎士: '骑士',
  ghost: '幽灵',
  幽霊: '幽灵',
  demon: '恶魔',
  悪魔: '恶魔',
  angel: '天使',
  vtuber: 'VTuber',
  catgirl: '猫娘',
  nekomimi: '猫耳',
  猫耳: '猫耳',
  kitsune: '狐娘',
  // 题材
  romance: '恋爱',
  comedy: '喜剧',
  fantasy: '奇幻',
  sci: '科幻',
  scifi: '科幻',
  sf: '科幻',
  horror: '恐怖',
  mystery: '悬疑',
  isekai: '异世界',
  異世界: '异世界',
  school: '校园',
  学園: '校园',
  sliceoflife: '日常',
  'slice-of-life': '日常',
  'slice of life': '日常',
  yuri: '百合',
  gl: '百合',
  bl: '耽美',
  'boys love': '耽美',
  boyslove: '耽美',
  harem: '后宫',
  reverseharem: '逆后宫',
  vanilla: '纯爱',
  fluff: '甜文',
  angst: '虐心',
  smut: '色气',
  wholesome: '治愈',
  slowburn: '慢热',
  enemies2lovers: '相爱相杀',
  'enemies to lovers': '相爱相杀',
  crossover: '联动',
  au: '平行世界',
  canon: '原作向',
  modernau: '现代 AU',
  nsfw: '成人向',
  oc: '原创角色',
  furry: '兽人',
  kemono: '兽人',
  ケモノ: '兽人',
  loli: '萝莉',
  shota: '正太',
  milf: '熟女',
};

/** 认不出来就原样返回；认出来给中文，原文留给 tooltip。 */
export function translateTag(tag) {
  const raw = String(tag ?? '').trim();
  if (!raw) return { raw: '', label: '', translated: false };
  const hit = TAG_DICT[raw] ?? TAG_DICT[raw.toLowerCase()];
  return hit ? { raw, label: hit, translated: true } : { raw, label: raw, translated: false };
}

export const TAG_DICT_SIZE = Object.keys(TAG_DICT).length;
