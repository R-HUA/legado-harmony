// 哔哩轻小说（linovelib.com / bilinovel.com）书源专用的生成与校验库。
//
// 这里同时是“书源 JSON 的唯一来源”和“离线回归的被测对象”，因此任何规则改动都必须先通过
// `node scripts/linovelib-source-check.mjs`，再重新生成 docs/book-sources 下的 JSON。
//
// 两条约束决定了下面的写法：
// 1. `cleanLinovelibDocument` 只在**被抓取的页面里**执行，用于按浏览器真实布局剔除站点注入的
//    干扰段落；它通过 `chapterUrl` 的 `webJs` 选项交付，不进入规则引擎执行。
// 2. `linovelibChapterUrl` / `linovelibNextPage` 会进入书源 jsLib，由规则引擎逐元素调用。
//    它们刻意避开箭头函数、模板字符串、`try`、`Set/Map`、数组高阶函数、`while/do/switch`
//    以及 `document` 等 DOM 标识——出现这些会让 `BookSourceRuntimeRouter` 把整个 URL 规则阶段
//    路由到分阶段 ArkWeb。能力分析不检查字符串字面量内容，所以净化脚本以字符串常量
//    （LINOVELIB_CHAPTER_SUFFIX）随 jsLib 携带。
//
// 站点背景（2026-10-06 实测，详见书源备注）：
// - 桌面站对非浏览器请求返回“段落顺序被打乱/章节被降级”的 HTML；同一个 URL 在真实浏览器里
//   顺序正常，但混有 position:absolute 且 0×0 的干扰段落。因此桌面正文必须走 `webView: true`，
//   由页面脚本按可见布局净化，不能只靠 HTTP 文本。
// - 桌面 `/novel/*`（详情/目录/章节）与 `/S6/` 搜索页可直接请求；`/wenku/*` 排行榜返回 403。
// - 两个站点的搜索表单都需要页面脚本建立的搜索会话：同样的 POST 直接请求只得到 200 + 空响应，
//   所以搜索请求交给隐藏 ArkWeb，并需要用户先用书源的“搜索会话”按钮打开一次站点。

export const desktopUserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

export const mobileUserAgent =
  'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const desktopHeaders = {
  'User-Agent': desktopUserAgent,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://www.linovelib.com/'
};

export const mobileHeaders = {
  'User-Agent': mobileUserAgent,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://www.bilinovel.com/'
};

/**
 * 在已渲染的章节页里执行，返回“按可见布局净化后”的整页 HTML。
 *
 * 依据（用户浏览器实测）：站点在 `#TextContent` 内混入不可见干扰段落，其计算样式为
 * `position:absolute` 且 `getBoundingClientRect()` 宽高均为 0；正常段落为 `position:static`
 * 且宽高非 0。除该几何特征外，两类段落的 display/visibility/opacity/颜色完全一致，
 * 所以只看 innerText、可见性或“删除重复句子”都无法可靠区分——重复对白在原作里是正常的。
 *
 * 因此在**原文档**上测量、在**克隆文档**上删除：既能返回与真实阅读页一致的整页 HTML，
 * 又不修改正在显示的页面。任何无法确认布局的情况都直接抛错，宁可失败也不保存未过滤正文。
 */
export function cleanLinovelibDocument() {
  var root = document.querySelector('#TextContent');
  if (!root) throw new Error('正文容器 #TextContent 缺失：可能被验证页或站点改版替换');
  var box = root.getBoundingClientRect();
  if (document.readyState !== 'complete' || box.width <= 1 || box.height <= 0) {
    throw new Error('正文布局未就绪，已放弃保存未过滤正文');
  }
  var clone = document.documentElement.cloneNode(true);
  var target = clone.querySelector('#TextContent');
  // 站点的降级页/限制页先给出明确原因，避免被后面的“正文为空”掩盖。
  var marker = String(target.textContent || '');
  if (marker.indexOf('加載失敗') >= 0 || marker.indexOf('加载失败') >= 0) {
    throw new Error('站点提示内容加载失败，请稍后重试');
  }
  if (marker.indexOf('沒有可閱讀的章節') >= 0 || marker.indexOf('没有可阅读的章节') >= 0) {
    throw new Error('站点提示该章节不可阅读');
  }
  var paragraphs = root.querySelectorAll('p');
  var copies = target.querySelectorAll('p');
  var visible = 0;
  for (var i = 0; i < paragraphs.length && i < copies.length; i++) {
    var rect = paragraphs[i].getBoundingClientRect();
    var style = getComputedStyle(paragraphs[i]);
    if (style.position === 'absolute' && rect.width === 0 && rect.height === 0) {
      copies[i].parentNode.removeChild(copies[i]);
      continue;
    }
    if (rect.width > 0 && rect.height > 0 && String(paragraphs[i].textContent || '').replace(/\s+/g, '')) visible++;
  }
  if (visible <= 0 && root.querySelectorAll('img').length === 0) {
    throw new Error('正文为空或仍在渲染，本次不保存');
  }
  var junk = target.querySelectorAll('.dag,script,ins.adsbygoogle');
  for (var j = junk.length - 1; j >= 0; j--) junk[j].parentNode.removeChild(junk[j]);
  var images = target.querySelectorAll('img');
  for (var k = 0; k < images.length; k++) {
    var original = images[k].getAttribute('data-src') || images[k].getAttribute('data-original');
    if (original) images[k].setAttribute('src', original);
  }
  return '<!DOCTYPE html>' + clone.outerHTML;
}

/**
 * `chapterUrl` 需要的请求选项后缀。章节页必须走隐藏 ArkWeb，否则站点只返回降级 HTML。
 * 整个后缀（含净化脚本源码）在此静态生成，规则侧只做字符串拼接，不依赖 JSON.stringify、
 * 正则或任何宿主能力。
 */
export function chapterUrlSuffix() {
  return ',' + JSON.stringify({
    webView: true,
    webJs: '(' + cleanLinovelibDocument.toString() + ')()'
  });
}

/** jsLib 里 LINOVELIB_CHAPTER_SUFFIX 常量的赋值语句（字面量已转义，可直接内联）。 */
export function chapterSuffixDeclaration() {
  return 'var LINOVELIB_CHAPTER_SUFFIX = ' + JSON.stringify(chapterUrlSuffix()) + ';';
}

/** jsLib 源码：常量声明在前，两个 URL 辅助函数在后（顺序即执行顺序）。 */
export function linovelibJsLib() {
  return [
    chapterSuffixDeclaration(),
    linovelibChapterUrl.toString(),
    linovelibNextPage.toString(),
    linovelibChapterParts.toString()
  ].join('\n');
}

/**
 * 目录/正文里的链接 → 带回请求选项的章节地址。
 * 只接受桌面站同书同章的 `/novel/<书号>/<章节号>[_页码].html`：卷封面（`vol_*.html`）、目录页、
 * `javascript:` 脚本链接和移动版域名都会返回空字符串，由 WebBookService 丢弃，
 * 避免把卷页或跨站地址当成正文请求。
 */
export function linovelibChapterUrl(value) {
  var text = String(value || '').trim();
  if (text.indexOf('/novel/') === 0) text = 'https://www.linovelib.com' + text;
  if (!/^https:\/\/www\.linovelib\.com\/novel\/\d+\/\d+(?:_\d+)?\.html$/.test(text)) return '';
  return text + LINOVELIB_CHAPTER_SUFFIX;
}

/**
 * 正文下一页。站点约定：`196483.html` → `196483_2.html` → `196483_3.html`；
 * 而 `67909.html` → `67910.html` 是**下一章**，不能拼接。
 * 因此要求下一页链接与原章节同书号、同章节号，且页码恰好 +1：不跨章、不跨书、不回退、不跳跃。
 * `current` 取当前响应地址（baseUrl），`original` 取章节原始地址（chapter.url）。
 */
export function linovelibNextPage(next, current, original) {
  var n = linovelibChapterParts(next);
  var c = linovelibChapterParts(current);
  var o = linovelibChapterParts(original);
  if (!n || !c || !o) return '';
  if (n.book !== c.book || n.book !== o.book) return '';
  if (n.chapter !== c.chapter || n.chapter !== o.chapter) return '';
  if (n.page !== c.page + 1) return '';
  return linovelibChapterUrl(n.url);
}

function linovelibChapterParts(value) {
  var text = String(value || '').trim().split(',')[0].split('#')[0];
  if (text.indexOf('/novel/') === 0) text = 'https://www.linovelib.com' + text;
  var match = /^https:\/\/www\.linovelib\.com\/novel\/(\d+)\/(\d+)(?:_(\d+))?\.html$/.exec(text);
  if (!match) return null;
  return { url: text, book: match[1], chapter: match[2], page: Number(match[3] || 1) };
}

const SOURCE_COMMENT = [
  '哔哩轻小说。桌面站 linovelib.com 与移动站 bilinovel.com 是同一套后端、两套主题：书籍/章节路径完全相同',
  '（/novel/<书号>.html、/novel/<书号>/<章节号>.html），在 PC 上访问移动站的正文会被站点自己跳回桌面站。',
  '',
  '本源的取舍：',
  '- 搜索、详情、目录、正文都走桌面站：只有桌面主题给出完整正文（移动主题只给预览）。',
  '- 发现列表走移动站的 /wenku/<分类>_0_0_0_0_0_0_0_<页码>_0.html（每页 30 条，可翻页）；',
  '  桌面站的同一路径对非浏览器请求返回 403，而这条列表在移动站可以正常取到，',
  '  完全对称于站点自己“PC 发现 → 点进正文 → 回到桌面主题”的行为。',
  '  列表里的 /novel/<书号>.html 会按同一路径改写到桌面主机，因此详情/目录/正文不会落到只给预览的移动主题。',
  '',
  '【站点限制，不是书源缺陷】',
  '1) 搜索表单需要页面脚本先建立会话：同样的 POST 直接请求（含完整浏览器请求头）只得到 200 + 空响应，',
  '   两个站点的表现一致。因此搜索请求交给隐藏 ArkWeb，并请在书源菜单点“搜索会话”，',
  '   在打开的站点里正常浏览/完成验证后返回；站点不要求注册或登录。',
  '   搜索仅第 1 页——本应用搜索阶段固定 page=1，书源不提供不存在的 nextSearchUrl。',
  '2) 章节页对非浏览器请求返回“段落顺序被打乱”的降级 HTML，并且页面里混有 position:absolute 且 0×0 的',
  '   干扰段落。因此每个章节地址都带 webView+webJs：在页面里按真实布局净化后再交给正文规则。',
  '   净化失败会抛错中止，不会保存未过滤正文；不会按句子去重（原作存在重复对白）。',
  '3) 正文分页只跟随同书同章 页码+1 的“下一页”：196483→196483_2→196483_3 可拼接，',
  '   67909→67910 这类跨章链接会被拒绝。',
  '4) 目录里 javascript:cid(0) 的条目是站点锁定章节（需购买/权限），没有可用地址，会被丢弃：',
  '   实测某书 119 条 li.col-4 中有 5 条属于此类，其余 114 条可正常阅读。',
  '',
  '未经真机验收：搜索会话后的 POST 是否被站点接受、桌面站 /wenku/ 是否能在隐藏 ArkWeb 中通过站点校验、',
  '以及站点验证页的交互。'
].join('\n');

/** 发现页链接 → 桌面主机上的同路径书籍页。两种主机、绝对或相对写法都能归一。 */
const EXPLORE_BOOK_URL =
  '@css:a.book-layout@href##^(?:https?://www\\.(?:linovelib|bilinovel)\\.com)?(/novel/\\d+\\.html)$' +
  '##https://www.linovelib.com$1';

/**
 * 唯一的哔哩轻小说书源：桌面站负责搜索/详情/目录/正文，移动站负责发现列表。
 *
 * 这不是“两个源合并成一个入口”，而是按站点自身的分工取用：PC 上访问移动站正文会被站点跳回桌面站，
 * 而桌面站的排行榜路径又对非浏览器请求 403——两条路径互为补充，正好落在同一个书源里。
 */
export function buildSource() {
  return [{
    bookSourceName: '哔哩轻小说',
    bookSourceUrl: 'https://www.linovelib.com/',
    bookSourceGroup: '哔哩轻小说',
    bookSourceType: 0,
    bookSourceComment: SOURCE_COMMENT,
    enabled: true,
    enabledExplore: true,
    enabledCookieJar: true,
    header: JSON.stringify(desktopHeaders),
    loginUi: JSON.stringify([{
      type: 'button',
      name: '搜索会话',
      action: "java.startBrowserAwait('https://www.linovelib.com/','在打开的站点里正常浏览/完成验证后返回；站点搜索需要页面脚本建立的会话，不要求注册或登录');"
    }]),
    jsLib: linovelibJsLib(),
    // 站点搜索只接受表单 POST；直接请求（含完整浏览器请求头）返回 200 + 空响应，所以交给隐藏 ArkWeb。
    searchUrl: 'https://www.linovelib.com/S6/,' + JSON.stringify({
      method: 'POST',
      body: 'searchkey={{key}}',
      webView: true,
      headers: { Referer: 'https://www.linovelib.com/', Origin: 'https://www.linovelib.com' }
    }),
    exploreUrl: JSON.stringify([
      { title: '最近更新', url: 'https://www.bilinovel.com/wenku/lastupdate_0_0_0_0_0_0_0_{{page}}_0.html' },
      { title: '新书入库', url: 'https://www.bilinovel.com/wenku/postdate_0_0_0_0_0_0_0_{{page}}_0.html' },
      { title: '总点击榜', url: 'https://www.bilinovel.com/wenku/allvisit_0_0_0_0_0_0_0_{{page}}_0.html' },
      { title: '完本小说', url: 'https://www.bilinovel.com/wenku/completed_0_0_0_0_0_0_0_{{page}}_0.html' }
    ]),
    ruleSearch: {
      bookList: '@css:.search-result-list.clearfix',
      name: '@css:.tit a@text',
      bookUrl: '@css:.tit a@href',
      // 需要“第 N 个元素”的字段一律用阅读 Default 语法（class./tag. + 结尾 .N）：
      // 上游的 `.N` 索引只在 Default 模式生效，写在 `@css:` 选择器里会被 jsoup 当成
      // class="0" 之类的字面量，静默取空。
      author: 'class.bookinfo@tag.a.0@text',
      coverUrl: '@css:.se-result-book img@src',
      intro: '@css:.se-result-infos p@text',
      kind: '@css:.key-word@text',
      status: 'class.bookinfo@tag.span.0@text',
      wordCount: 'class.bookinfo@tag.span.1@text'
    },
    ruleExplore: {
      bookList: '@css:ol.book-ol-normal li.book-li',
      name: '@css:.book-title@text',
      bookUrl: EXPLORE_BOOK_URL,
      coverUrl: '@css:.book-cover img@data-src',
      intro: '@css:.book-desc@text',
      author: '@css:.book-author@text##^作者\\s*',
      kind: '@css:.tag-small.yellow@text',
      wordCount: '@css:.tag-small.blue@text'
    },
    ruleBookInfo: {
      name: '@css:h1.book-name@text',
      author: 'class.au-name@tag.a.0@text',
      coverUrl: '@css:.book-img img@src',
      // `||` 的备用分支不能重复写 `@css:`：上游只在整条规则最前面识别一次前缀，
      // 第二段的 `@css:` 会被当成选择器一起交给 jsoup，直接抛
      // `Could not parse query '@css:…'`。
      intro: 'class.book-dec@tag.p.1@text||class.book-dec@tag.p.0@text',
      kind: 'class.book-label@tag.span@tag.a.0@text',
      status: '@css:.book-label .state@text',
      wordCount: 'class.nums@tag.span.1@text##^字数：',
      updateTime: 'class.nums@tag.span.0@text##^最后更新：',
      // 目录入口不能只看“阅读”按钮：部分书籍的 .read-btn 是 javascript:;（按钮由页面脚本接管），
      // 直接取它会把 javascript:; 当成目录地址。改为优先取本书自己的 /catalog 链接，并清掉脚本值。
      // 两个分支共用开头那一个 `@css:`，第二段不再重复写前缀。
      tocUrl: '@css:a[href$="/catalog"]@href||.read-btn@href##^javascript:[\\s\\S]*'
    },
    ruleToc: {
      chapterList: '@css:li.col-4',
      chapterName: '@css:a@text',
      chapterUrl: '@css:a@href@js:linovelibChapterUrl(result)',
      nextTocUrl: ''
    },
    ruleContent: {
      content: '@css:#TextContent@html',
      imageStyle: 'FULL',
      nextContentUrl: 'text.下一页@href@js:linovelibNextPage(result,baseUrl,chapter.url)'
    }
  }];
}
