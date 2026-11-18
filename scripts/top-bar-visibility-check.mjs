import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { projectRoot } from './lib/ets-module-staging.mjs';

const etsRoot = path.join(projectRoot, 'entry', 'src', 'main', 'ets');

function listEtsFiles(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listEtsFiles(full));
    } else if (entry.name.endsWith('.ets')) {
      result.push(full);
    }
  }
  return result;
}

const files = listEtsFiles(etsRoot);
const readRel = rel => fs.readFileSync(path.join(etsRoot, rel), 'utf8');

// 1. Only ExplorePage (scrollable discovery) and BookshelfPage (explicit shelfImmersiveActive()) may hide titleArea.
const hideTitleAreaMatches = [];
for (const file of files) {
  const rel = path.relative(etsRoot, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  const matches = [...text.matchAll(/hideTitleArea:\s*([^,\n}]+)/g)];
  for (const m of matches) {
    hideTitleAreaMatches.push({ rel, expr: m[1].trim() });
    if (m[1].trim() === 'false') continue;
    if (rel === 'components/home/ExplorePage.ets') {
      assert.ok(m[1].includes('exploreCanCollapseHeader'), `${rel}: ExplorePage hideTitleArea must stay gated`);
    } else if (rel === 'components/home/BookshelfPage.ets') {
      assert.ok(m[1].includes('shelfImmersiveActive()'),
        `${rel}: BookshelfPage hideTitleArea must require shelfImmersiveActive(), got: ${m[1]}`);
    } else {
      assert.fail(`${rel}: unexpected non-false hideTitleArea (${m[1].trim()})`);
    }
  }
  // 2. HitTestMode.None never blocks descendants on interactive overlays.
  assert.doesNotMatch(text, /CollapsingHeader\.acceptsTouch\([^)]*\)\s*\?\s*HitTestMode\.Default\s*:\s*HitTestMode\.None/,
    `${rel}: must not use HitTestMode.None for hidden interactive header controls`);
}
assert.ok(hideTitleAreaMatches.length >= 10, 'expected to inspect all HdsNavigation hideTitleArea declarations');

// 3. ExplorePage hides with SCROLL_UP from any scroll offset and closes popups / blocks descendants when hidden.
const explore = readRel('components/home/ExplorePage.ets');
assert.match(explore, /mode:\s*HideMode\.SCROLL_UP\b/, 'ExplorePage must use HideMode.SCROLL_UP');
assert.doesNotMatch(explore, /nativeExploreTitleCollapse|nativeExploreScrollY/,
  'ExplorePage must use delta-based exploreHeaderCollapseValue rather than absolute scrollY');
assert.ok(explore.includes('HitTestMode.BLOCK_DESCENDANTS') && explore.includes('Visibility.Hidden'),
  'ExplorePage actions overlay must block descendants and hide when collapsed');
assert.ok(explore.includes('closeExploreFilterPanel') && explore.includes('showExploreMoreMenu = false'),
  'ExplorePage must dismiss open header menus on collapse');
assert.ok(explore.includes('mainTitleSize: TitleSize.TITLE_ML'), 'ExplorePage must configure TitleSize.TITLE_ML');

// 4. SearchPage keeps search bar pinned and derives bottom-bar progress from delta searchBarCollapse.
const search = readRel('components/home/SearchPage.ets');
assert.doesNotMatch(search, /nativeSearchTitleCollapse|nativeSearchScrollY/,
  'SearchPage must use delta-based searchBarCollapse rather than absolute scrollY');
assert.match(search, /CollapsingHeader\.next\(this\.searchBarCollapse,/,
  'SearchPage must compute bottom-bar progress incrementally via CollapsingHeader.next');

// 5. BookSource keeps group/format filter bar pinned.
const bookSource = readRel('pages/BookSource.ets');
assert.doesNotMatch(bookSource, /hideBottomBuilder:\s*!/, 'BookSource bottomBuilder must stay pinned');
assert.match(bookSource, /hideBottomBuilder:\s*false/, 'BookSource must explicitly set hideBottomBuilder: false');

// 6. Root home tabs configure TitleSize.TITLE_ML.
for (const rel of [
  'components/home/SettingsTabPage.ets',
  'components/home/ListenTabPage.ets',
  'components/home/FootprintTabPage.ets',
  'components/home/BookshelfPage.ets'
]) {
  const src = readRel(rel);
  assert.ok(src.includes('TitleSize.TITLE_ML'), `${rel}: must configure TitleSize.TITLE_ML`);
}
assert.doesNotMatch(readRel('components/home/SettingsTabPage.ets'), /nativeActionsCollapse/,
  'SettingsTabPage actions stay pinned without nativeActionsCollapse');
assert.doesNotMatch(readRel('components/home/FootprintTabPage.ets'), /nativeActionsCollapse/,
  'FootprintTabPage actions stay pinned without nativeActionsCollapse');

// 7. PageScaffold supports reactive scroller rebinding and MimoVoices passes scrollerProvider + scrollBindingKey.
const scaffoldSrc = readRel('components/common/PageScaffold.ets');
assert.ok(scaffoldSrc.includes('scrollerProvider:') && scaffoldSrc.includes('@Prop scrollBindingKey:'),
  'PageScaffold must declare scrollerProvider and @Prop scrollBindingKey');
assert.doesNotMatch(scaffoldSrc, /nativeActionsCollapse|nativeScrollY/,
  'PageScaffold actions stay pinned without nativeActionsCollapse/nativeScrollY');
const mimoSrc = readRel('pages/MimoVoices.ets');
assert.ok(mimoSrc.includes('scrollerProvider:') && mimoSrc.includes('scrollBindingKey: this.screen'),
  'MimoVoices must pass scrollerProvider and scrollBindingKey: this.screen');

// Execute PageScaffold.allScrollers in VM across screen switches.
const methodStart = scaffoldSrc.indexOf('  private allScrollers()');
const methodEnd = scaffoldSrc.indexOf('\n  }', methodStart) + 4;
const methodCode = scaffoldSrc.slice(methodStart, methodEnd).replace('private ', '');
const classCode = stripTypeScriptTypes(`class Scaffold {\n${methodCode}\n}`, { mode: 'strip' });
const Scaffold = vm.runInContext(`${classCode}; Scaffold`, vm.createContext({}));
const scaffold = new Scaffold();
const schemeScroller = { id: 'scheme' };
const presetScroller = { id: 'preset' };
const contentScroller = { id: 'content' };
let activeScreen = 'schemes';
Object.assign(scaffold, {
  scrollable: false,
  scroller: undefined,
  extraScrollers: [],
  contentScroller,
  scrollBindingKey: 'schemes',
  scrollerProvider: () => activeScreen === 'schemes' ? [schemeScroller] :
    (['library', 'default', 'schemeEdit'].includes(activeScreen) ? [presetScroller] : [])
});
assert.deepEqual(Array.from(scaffold.allScrollers()), [schemeScroller]);
activeScreen = 'library';
scaffold.scrollBindingKey = 'library';
assert.deepEqual(Array.from(scaffold.allScrollers()), [presetScroller]);
activeScreen = 'edit';
scaffold.scrollable = true;
scaffold.scrollBindingKey = 'edit';
assert.deepEqual(Array.from(scaffold.allScrollers()), [contentScroller]);

// 8. LocalBookSettings is book-URL-only without redundant local file tab.
const localBook = readRel('pages/LocalBookSettings.ets');
assert.doesNotMatch(localBook, /本地文件|chooseBookFiles|SegmentButton|localScroller|localImportPanel/,
  'LocalBookSettings must not contain local file import controls');
assert.match(localBook, /title:\s*'书籍链接'/, 'LocalBookSettings must title itself 书籍链接');

console.log('Top bar visibility and scroller rebind checks passed.');
