import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, useTags } from '../api/queries';
import { ErrorText, Input, TagChip } from './ui';

/**
 * Local-first tag editing: `local` is the source of truth for quick
 * successive edits (each save sends the complete current set, so an earlier
 * in-flight save can never erase a later addition). The component remounts
 * per person via the key on PersonDetail, so state can't leak across people.
 */
export default function TagEditor({ personId, tags }: { personId: number; tags: string[] }) {
  const [local, setLocal] = useState(tags);
  const [draft, setDraft] = useState('');
  const lastAcked = useRef(tags);
  const allTags = useTags();
  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: api.setTags,
    onSuccess: (serverTags) => {
      lastAcked.current = serverTags;
      void queryClient.invalidateQueries();
    },
    onError: () => {
      setLocal(lastAcked.current);
    },
  });

  const commit = (next: string[]) => {
    setLocal(next);
    save.mutate({ id: personId, tags: next });
  };

  const add = () => {
    const name = draft.trim();
    setDraft('');
    if (!name) return;
    if (local.some((t) => t.toLowerCase() === name.toLowerCase())) return;
    commit([...local, name]);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {local.map((tag) => (
          <TagChip key={tag} name={tag} onRemove={() => commit(local.filter((t) => t !== tag))} />
        ))}
        <Input
          list="all-tags"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder="add tag…"
          className="!w-28 !px-2 !py-0.5 !text-xs"
        />
        <datalist id="all-tags">
          {(allTags.data ?? []).map((t) => (
            <option key={t.id} value={t.name} />
          ))}
        </datalist>
      </div>
      <ErrorText error={save.error} />
    </div>
  );
}
