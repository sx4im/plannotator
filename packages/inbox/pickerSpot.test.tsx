/**
 * The `@` list and the recipient list, where they sit when the page is laid
 * out (issue #3427): above the composer, measured, never inside the field's
 * own boxes. The failure this catches: a list drawn in place inside
 * `.ib-rscroll` (the `@` list) or cut by the pane's top edge (the recipient
 * list in a short pane), so the person sees nothing, or not every agent.
 * Both lists are placed on the screen instead, as wide as their anchor, above
 * it, capped by the thread's header, so every row stays reachable by
 * scrolling the list. Without layout (a test DOM) they keep their place in
 * the page, as before.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MentionMenuState } from '@plannotator/ui/hooks/useMentionAutocomplete';
import type { MentionPerson } from '@plannotator/ui/utils/mentions';
import { TagPicker } from './components/TagPicker';
import { ReplyRecipient } from './components/ReplyRecipient';
import type { RecipientRow } from './replyRecipients';
import type { TagOption } from './tags';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  if (!hasDom) return;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** A laid-out box: what getBoundingClientRect returns in a browser. */
function rect(top: number, left: number, width: number, height: number): DOMRect {
  return { top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function stubRect(el: Element, box: DOMRect): void {
  (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => box;
}

const PERSON = (id: string, label: string): MentionPerson => ({ id, kind: 'agent', label, detail: 'billing-api · working', group: 'Claude Code' });
const OPTION = (id: string, label: string): TagOption => ({
  id,
  host: 'claude-code',
  label,
  agent: 'Claude Code',
  detail: 'billing-api · working · since 9:14 AM',
  group: 'Claude Code',
  owner: id === 'ses_a',
  wakes: true,
  taggable: true,
  project: 'superfans',
});

function tagMenu(): MentionMenuState {
  return { items: [PERSON('ses_a', 'Claude Code'), PERSON('ses_b', 'Pi')], emptyNotice: null, heading: null, activeIndex: null, anchor: null, query: '' };
}

test.skipIf(!hasDom)('the @ list is placed on the screen above a laid-out field, as wide as the field', async () => {
  act(() => {
    root!.render(
      <div className="ib-cfield">
        <TagPicker id="tag-list" menu={tagMenu()} options={[OPTION('ses_a', 'Claude Code'), OPTION('ses_b', 'Pi')]} onSelect={() => {}} />
      </div>,
    );
  });
  const list = host!.querySelector('[data-tag-picker]') as HTMLElement;
  const field = host!.querySelector('.ib-cfield') as HTMLElement;
  // Laid out, the field's top at 600 px: the list hangs off it, capped at the list's own 430 px.
  stubRect(field, rect(600, 100, 500, 60));
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  expect(list.style.position).toBe('fixed');
  expect(list.style.top).toBe('592px');
  expect(list.style.left).toBe('100px');
  expect(list.style.width).toBe('500px');
  expect(list.style.transform).toBe('translateY(-100%)');
  expect(list.style.maxHeight).toBe('430px');
});

test.skipIf(!hasDom)('the @ list is capped by the room above a high field, never below one row', async () => {
  act(() => {
    root!.render(
      <div className="ib-cfield">
        <TagPicker id="tag-list" menu={tagMenu()} options={[OPTION('ses_a', 'Claude Code'), OPTION('ses_b', 'Pi')]} onSelect={() => {}} />
      </div>,
    );
  });
  const list = host!.querySelector('[data-tag-picker]') as HTMLElement;
  const field = host!.querySelector('.ib-cfield') as HTMLElement;
  // Only 192 px above the field: the list takes that room, less its gap.
  stubRect(field, rect(200, 100, 500, 60));
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  expect(list.style.position).toBe('fixed');
  expect(list.style.maxHeight).toBe('184px');
});

test.skipIf(!hasDom)('without layout the @ list keeps its place in the page', async () => {
  act(() => {
    root!.render(
      <div className="ib-cfield">
        <TagPicker id="tag-list" menu={tagMenu()} options={[OPTION('ses_a', 'Claude Code'), OPTION('ses_b', 'Pi')]} onSelect={() => {}} />
      </div>,
    );
  });
  const list = host!.querySelector('[data-tag-picker]') as HTMLElement;
  expect(list.style.position).toBe('');
});

const ROWS: RecipientRow[] = [
  { session: 'ses_a', host: 'claude-code', label: 'Claude Code (api)', short: 'api', state: 'live' },
  { session: 'ses_b', host: 'pi', label: 'Pi (web)', short: 'web', state: 'live' },
  { session: 'ses_c', host: 'codex', label: 'Codex (docs)', short: 'docs', state: 'ended' },
];

test.skipIf(!hasDom)('the recipient list is placed on the screen above the pill, right-aligned to it, with every agent listed', async () => {
  act(() => {
    root!.render(<ReplyRecipient rows={ROWS} chosen={[ROWS[0]!]} open onOpen={() => {}} onOnly={() => {}} onToggle={() => {}} onTagAnother={() => {}} />);
  });
  const list = host!.querySelector('[data-recipient-list]') as HTMLElement;
  const wrap = host!.querySelector('.ib-rto-wrap') as HTMLElement;
  // The pill's right edge at 800 px, its top at 700 px: the 300 px list hangs off it, capped at 430 px.
  stubRect(wrap, rect(700, 500, 300, 26));
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  expect(list.style.position).toBe('fixed');
  expect(list.style.top).toBe('694px');
  expect(list.style.left).toBe('500px');
  expect(list.style.width).toBe('300px');
  expect(list.style.transform).toBe('translateY(-100%)');
  expect(list.style.maxHeight).toBe('430px');
  expect([...host!.querySelectorAll('[data-recipient-row]')].map((r) => r.getAttribute('data-recipient-row'))).toEqual(['ses_a', 'ses_b', 'ses_c']);
});

test.skipIf(!hasDom)('without layout the recipient list keeps its place in the page', async () => {
  act(() => {
    root!.render(<ReplyRecipient rows={ROWS} chosen={[ROWS[0]!]} open onOpen={() => {}} onOnly={() => {}} onToggle={() => {}} onTagAnother={() => {}} />);
  });
  const list = host!.querySelector('[data-recipient-list]') as HTMLElement;
  expect(list.style.position).toBe('');
});
