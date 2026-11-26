import type { Stage } from '../../../shared/domain';
import type { PageProps } from '../App';
import { ContentList, useContent } from '../components/ContentList';

/** A page that shows the channel's content in a slice of the workflow. */
export function StagePage({
  channel,
  refreshKey,
  openEditor,
  title,
  description,
  stages,
  empty,
  allowCreate
}: PageProps & { title: string; description: string; stages: Stage[]; empty: string; allowCreate?: boolean }) {
  const { items, error } = useContent(channel.id, stages, refreshKey);
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="muted">{description}</p>
        </div>
        {allowCreate && (
          <button className="primary" onClick={() => openEditor('new')}>
            New idea
          </button>
        )}
      </header>
      {error && <div className="banner error">{error}</div>}
      <ContentList items={items} empty={empty} onOpen={openEditor} />
    </section>
  );
}
