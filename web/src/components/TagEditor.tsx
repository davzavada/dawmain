import { useState } from 'react';
import { api, useAppMutation, useTags } from '../api/queries';
import { ErrorText, Input, TagChip } from './ui';

export default function TagEditor({ personId, tags }: { personId: number; tags: string[] }) {
  const [draft, setDraft] = useState('');
  const allTags = useTags();
  const save = useAppMutation(api.setTags);

  const update = (next: string[]) => save.mutate({ id: personId, tags: next });

  const add = () => {
    const name = draft.trim();
    if (!name) return;
    if (!tags.some((t) => t.toLowerCase() === name.toLowerCase())) {
      update([...tags, name]);
    }
    setDraft('');
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <TagChip key={tag} name={tag} onRemove={() => update(tags.filter((t) => t !== tag))} />
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
