/**
 * The `@` picker and the recipient list are placed `fixed` above their
 * anchor, not `absolute` inside the reply box's scrolling `.ib-rscroll`
 * (issue #3427: the list was clipped and nothing showed). What regresses:
 * a laid-out anchor that leaves the menu `absolute` (clipped again), a
 * menu that lands below its anchor when there is room above it, or a
 * no-layout DOM that gets a `fixed` spot at 0,0.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MentionMenuState } from '@plannotator/ui/hooks/useMentionAutocomplete';
import type { TagOption } from './tags';
import type { RecipientRow } from './replyRecipients';

const hasDom = typeof document !== 'undefined';
const { TagPicker } = (hasDom ? await import('./components/TagPicker') : {}) as typeof import('./components/TagPicker');
const { ReplyRecipient } = (hasDom ? await import('./components/ReplyRecipient') : {}) as typeof import('./components/ReplyRecipient');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function render(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(node);
  });
  return host;
}

const EMPTY_MENU: MentionMenuState = { items: [], emptyNotice: 'No agent matches.', heading: null, activeIndex: null, anchor: null, query: '' };
const NO_OPTIONS: readonly TagOption[] = [];

type Rect = { top: number; left: number; width: number; height: number; bottom: number; right: number; x: number; y: number; toJSON: () => Record<string, never> };
const rect = (top: number, left: number, width: number, height: number): Rect => ({
  top,
  left,
  width,
  height,
  bottom: top + height,
  right: left + width,
  x: left,
  y: top,
  toJSON: () => ({}),
});

let laidOut: Rect;
const realRect = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  laidOut = rect(0, 0, 0, 0);
  Element.prototype.getBoundingClientRect = function (this: Element) {
    void this;
    return laidOut as unknown as DOMRect;
  };
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
});

test('tag picker is fixed above its anchor when laid out', () => {
  laidOut = rect(500, 100, 600, 60);
  const host = render(
    <div className="ib-cfield">
      <TagPicker id="ib-tags-test" menu={EMPTY_MENU} options={NO_OPTIONS} onSelect={() => {}} />
    </div>,
  );
  const menu = host.querySelector('[data-tag-picker]') as HTMLElement;
  expect(menu).not.toBeNull();
  expect(menu.style.position).toBe('fixed');
  expect(menu.style.top).toBe('492px');
  expect(menu.style.left).toBe('100px');
  expect(menu.style.width).toBe('600px');
  expect(menu.style.transform).toBe('translateY(-100%)');
  expect(menu.style.maxHeight).toBe(`${Math.max(88, 500 - 8 - 8)}px`);
});

test('tag picker hangs below its anchor when there is no room above it', () => {
  laidOut = rect(30, 100, 600, 60);
  const host = render(
    <div className="ib-cfield">
      <TagPicker id="ib-tags-test" menu={EMPTY_MENU} options={NO_OPTIONS} onSelect={() => {}} />
    </div>,
  );
  const menu = host.querySelector('[data-tag-picker]') as HTMLElement;
  expect(menu).not.toBeNull();
  expect(menu.style.position).toBe('fixed');
  expect(menu.style.top).toBe('98px');
  expect(menu.style.transform).toBe('');
  expect(menu.style.maxHeight).toBe(`${Math.max(88, window.innerHeight - 90 - 8 - 8)}px`);
});

test('tag picker keeps its CSS placement with no layout', () => {
  laidOut = rect(0, 0, 0, 0);
  const host = render(
    <div className="ib-cfield">
      <TagPicker id="ib-tags-test" menu={EMPTY_MENU} options={NO_OPTIONS} onSelect={() => {}} />
    </div>,
  );
  const menu = host.querySelector('[data-tag-picker]') as HTMLElement;
  expect(menu).not.toBeNull();
  expect(menu.style.position).toBe('');
});

test('recipient list is fixed above the pill, right-aligned', () => {
  laidOut = rect(500, 400, 200, 36);
  const row: RecipientRow = { session: 'ses_a', host: 'claude-code', label: 'Claude Code (plannotator)', short: 'plannotator', state: 'live' };
  const host = render(
    <ReplyRecipient rows={[row]} chosen={[row]} open onOpen={() => {}} onOnly={() => {}} onToggle={() => {}} onTagAnother={() => {}} />,
  );
  const list = host.querySelector('[data-recipient-list]') as HTMLElement;
  expect(list).not.toBeNull();
  expect(list.style.position).toBe('fixed');
  expect(list.style.top).toBe('494px');
  expect(list.style.left).toBe('300px');
  expect(list.style.width).toBe('300px');
  expect(list.style.transform).toBe('translateY(-100%)');
});
