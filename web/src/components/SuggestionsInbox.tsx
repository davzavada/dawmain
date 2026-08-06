import { useState } from 'react';
import {
  api,
  useAppMutation,
  useDismissedSuggestions,
  usePeople,
  useSuggestions,
} from '../api/queries';
import { Btn, ErrorText, Select } from './ui';

export default function SuggestionsInbox() {
  const suggestions = useSuggestions();
  const dismissed = useDismissedSuggestions();
  const people = usePeople('', '');
  const [linking, setLinking] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState('');
  const [showDismissed, setShowDismissed] = useState(false);

  const promote = useAppMutation(api.promoteSuggestion);
  const link = useAppMutation(api.linkSuggestion, () => setLinking(null));
  const dismiss = useAppMutation(api.dismissSuggestion);
  const undismiss = useAppMutation(api.undismissSuggestion);

  const items = suggestions.data ?? [];
  const dismissedItems = dismissed.data ?? [];
  const busy = promote.isPending || link.isPending || dismiss.isPending;

  if (items.length === 0 && dismissedItems.length === 0) return null;

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-3">
      {items.length > 0 && (
        <>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-700">
            Suggested people — co-authors not in your contacts yet
          </h3>
          <ul className="space-y-1.5">
            {items.map((s) => (
              <li key={s.name} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{s.name}</span>
                <span
                  className="text-xs text-amber-700"
                  title={s.publications.map((p) => p.title).join('\n')}
                >
                  on {s.count} publication{s.count > 1 ? 's' : ''}
                </span>
                <span className="flex-1" />
                {linking === s.name ? (
                  <span className="flex items-center gap-1">
                    <Select
                      value={linkTarget}
                      onChange={(e) => setLinkTarget(e.target.value)}
                      className="!w-44 !py-1"
                    >
                      <option value="">— existing contact —</option>
                      {(people.data ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                    <Btn
                      variant="subtle"
                      disabled={!linkTarget || link.isPending}
                      onClick={() => link.mutate({ name: s.name, person_id: Number(linkTarget) })}
                    >
                      Link
                    </Btn>
                    <Btn variant="ghost" onClick={() => setLinking(null)}>
                      ✕
                    </Btn>
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <Btn
                      variant="subtle"
                      disabled={busy}
                      onClick={() => promote.mutate({ name: s.name })}
                    >
                      Add as contact
                    </Btn>
                    <Btn
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setLinking(s.name);
                        setLinkTarget('');
                      }}
                    >
                      Link to existing…
                    </Btn>
                    <Btn variant="ghost" disabled={busy} onClick={() => dismiss.mutate(s.name)}>
                      Dismiss
                    </Btn>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {dismissedItems.length > 0 && (
        <div className={items.length > 0 ? 'mt-2 border-t border-amber-100 pt-2' : ''}>
          <button
            type="button"
            onClick={() => setShowDismissed((v) => !v)}
            className="text-xs text-amber-700 hover:underline"
          >
            {showDismissed ? 'Hide' : 'Show'} dismissed ({dismissedItems.length})
          </button>
          {showDismissed && (
            <ul className="mt-1 space-y-1">
              {dismissedItems.map((d) => (
                <li key={d.author_name} className="flex items-center gap-2 text-xs text-slate-600">
                  <span>{d.author_name}</span>
                  <button
                    type="button"
                    onClick={() => undismiss.mutate(d.author_name)}
                    className="text-amber-700 hover:underline"
                    disabled={undismiss.isPending}
                  >
                    undo
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ErrorText error={promote.error ?? link.error ?? dismiss.error ?? undismiss.error} />
    </div>
  );
}
