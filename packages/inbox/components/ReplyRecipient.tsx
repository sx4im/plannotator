/**
 * Who gets the reply (approval "inbox-reply-recipient", option E "Under the
 * box, right"): in a thread with more than one agent, a pill in the box's own
 * row, at the right of what goes with the reply, "to [tile] Claude Code
 * (plannotator) ⌄" (approval "inbox-reply-box", T6). A computer only: a phone's
 * is PhoneReplyRecipient.tsx, in the row with a bottom sheet.
 *
 * Tap it for the thread's agents (live first, ended last), the chosen ones
 * ticked. Tap a name: only that agent. Tap a circle: that agent too ("2
 * agents", the names on hover). An ended agent, or one on an older
 * Plannotator, can't be a second recipient. The last row, "Tag another
 * agent", types a real `@`. The list is the `@` list's box and tiles, not its
 * code (that one follows the caret and only adds).
 *
 * The rules are replyRecipients.ts; ThreadPane owns the choice and Send.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { HostMark, Icon } from '../icons';
import { canAddRecipient, type RecipientRow } from '../replyRecipients';
import { skillListRoom } from '../caretMenu';
import { namesList } from '../tags';
import { TagStack } from './TagPicker';
import { Tip } from './Tip';
import { markRecipientList } from '../pageMarks';

function Face({ tile, full, short, ended }: { tile: ReactNode; full: string; short: string; ended: boolean }) {
  return (
    <>
      <span className="ib-rto-l">to</span>
      {tile}
      <span className="ib-rto-n">
        <span className="ib-rto-full" dir="auto">
          {full}
        </span>
        <span className="ib-rto-short" dir="auto">
          {short}
        </span>
      </span>
      {ended && <span className="ib-rto-q">ended</span>}
      <svg className="ib-rto-c" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </>
  );
}

const QUIET: Record<RecipientRow['state'], string | null> = { live: null, ended: 'ended', reader: 'Not woken', old: 'Update' };

/**
 * Where the recipient list sits: above the pill, measured, never inside the
 * box's own boxes. The list is `absolute` against the pill's wrap, and the
 * pane's `overflow: hidden` cuts what runs past its top edge, so in a short
 * pane the top agents never showed. A measured `fixed` placement escapes that
 * (no ancestor takes `transform` or `filter`, so the viewport is the list's
 * box): as wide as the list (300 px, right-aligned to the pill), above it,
 * capped by the thread's header, so every agent stays reachable by scrolling
 * the list. The tag picker (TagPicker.tsx) is placed the same way.
 */
function useListSpot(): { ref: RefObject<HTMLSpanElement | null>; style: CSSProperties | undefined } {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  const measure = useCallback(() => {
    const pill = ref.current;
    const box = pill?.getBoundingClientRect();
    // No layout (a test DOM): the list keeps its place in the page, as it always did there.
    if (!pill || !box || box.width === 0 || box.height === 0) {
      setStyle((current) => (current === undefined ? current : undefined));
      return;
    }
    const view = pill.ownerDocument.defaultView ?? window;
    const width = Math.min(300, Math.max(0, view.innerWidth - 24));
    const left = Math.max(12, Math.round(box.right - width));
    const top = Math.round(box.top - 6);
    // The room above the pill, under the thread's header (the visual viewport when there is no pane): the list
    // hangs off the pill's top edge, one whole row at least, never past the header.
    const room = skillListRoom(pill);
    const maxHeight = Math.max(88, Math.min(430, Math.round(top - room.top - 6)));
    setStyle((current) =>
      current && current.top === top && current.left === left && current.width === width && current.maxHeight === maxHeight
        ? current
        : { position: 'fixed', top, left, width, right: 'auto', bottom: 'auto', margin: 0, transform: 'translateY(-100%)', maxHeight },
    );
  }, []);
  // Every commit (the pill's words change when the choice does); the equality guard converges.
  useLayoutEffect(() => {
    measure();
  });
  // A scroll anywhere, a resize, the visual viewport (a phone's keyboard): the pill moves without a commit.
  useLayoutEffect(() => {
    const view = ref.current?.ownerDocument.defaultView ?? window;
    const onMove = () => measure();
    view.addEventListener('resize', onMove);
    view.addEventListener('scroll', onMove, true);
    view.visualViewport?.addEventListener('resize', onMove);
    view.visualViewport?.addEventListener('scroll', onMove);
    return () => {
      view.removeEventListener('resize', onMove);
      view.removeEventListener('scroll', onMove, true);
      view.visualViewport?.removeEventListener('resize', onMove);
      view.visualViewport?.removeEventListener('scroll', onMove);
    };
  }, [measure]);
  return { ref, style };
}

export function ReplyRecipient({
  rows,
  chosen,
  open,
  onOpen,
  onOnly,
  onToggle,
  onTagAnother,
}: {
  /** Every agent the list offers, live first, ended last. */
  rows: readonly RecipientRow[];
  /** Who gets the reply now, the one it answers first (a typed `@` included). */
  chosen: readonly RecipientRow[];
  open: boolean;
  onOpen: (open: boolean) => void;
  onOnly: (row: RecipientRow) => void;
  onToggle: (row: RecipientRow) => void;
  onTagAnother: () => void;
}) {
  const listId = useRef(`ib-rpick-${Math.random().toString(36).slice(2)}`).current;
  const chosenIds = chosen.map((r) => r.session);
  const spot = useListSpot();
  const one = chosen.length === 1 ? chosen[0]! : null;
  const names = namesList(chosen.map((r) => r.label));
  const ended = one?.state === 'ended';

  // A press outside the pill and its list closes the list; so does Escape, before anything else hears it.
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.('[data-recipient-list], [data-recipient]')) onOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onOpen(false);
    };
    document.addEventListener('pointerdown', press);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', press);
      window.removeEventListener('keydown', key, true);
    };
  }, [open, onOpen]);

  const tile = one ? (
    <span className="ib-atile">
      <HostMark host={one.host} agent={one.session} />
    </span>
  ) : (
    <TagStack participants={chosen} />
  );
  const words = one ? one.label : `${chosen.length} agents`;
  const button = (
    <button
      type="button"
      className="ib-rto"
      data-recipient=""
      data-ended={ended ? '' : undefined}
      aria-label={`To ${names}${ended ? ', ended' : ''}. Change who gets this reply`}
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      // The press must not take focus from the reply field.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onOpen(!open)}
    >
      <Face tile={tile} full={words} short={one ? one.short : words} ended={ended} />
    </button>
  );

  const list = open ? (
    <div ref={markRecipientList} className="ib-tg-menu ib-rpick" id={listId} data-recipient-list="" role="group" aria-label="Who gets this reply" style={spot.style} onMouseDown={(event) => event.preventDefault()}>
      {rows.map((row) => {
        const on = chosenIds.includes(row.session);
        const quiet = QUIET[row.state];
        return (
          <div key={row.session} className="ib-rpick-row" data-recipient-row={row.session} data-on={on ? '' : undefined}>
            <button type="button" className="ib-rpick-name" disabled={row.alone === false} onClick={() => onOnly(row)}>
              <span className="ib-atile">
                <HostMark host={row.host} agent={row.session} />
              </span>
              <span className="ib-rpick-l" dir="auto">
                {row.label}
              </span>
              {quiet && <span className="ib-rpick-q">{quiet}</span>}
            </button>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={`Also send to ${row.label}`}
              className="ib-rpick-tick"
              data-recipient-tick={row.session}
              disabled={!canAddRecipient(row, chosenIds)}
              onClick={() => onToggle(row)}
            >
              <span>
                <Icon name="check" size={12} />
              </span>
            </button>
          </div>
        );
      })}
      <button type="button" className="ib-rpick-more" data-recipient-tag="" onClick={onTagAnother}>
        Tag another agent
      </button>
    </div>
  ) : null;

  const pill = (
    <span className="ib-rto-wrap" ref={spot.ref}>
      {chosen.length > 1 && !open ? <Tip content={names}>{button}</Tip> : button}
      {list}
    </span>
  );
  // A wide window: every name stacked under the pill, so the Draft words beside it never move when it changes.
  return (
    <span className="ib-rto-slot">
      {rows.map((row) => (
        <span key={row.session} className="ib-rto ib-rto-ghost" aria-hidden="true">
          <Face tile={<span className="ib-atile" />} full={row.label} short={row.short} ended={row.state === 'ended'} />
        </span>
      ))}
      {pill}
    </span>
  );
}
