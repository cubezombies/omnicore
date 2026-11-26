import type { PageProps } from '../App';
import { StagePage } from './StagePage';

export function Studio(props: PageProps) {
  return (
    <StagePage
      {...props}
      title="Studio"
      description="Content being scripted, produced and reviewed."
      stages={['script', 'production', 'review']}
      empty="Nothing in production. Move a researched idea to Script to start."
    />
  );
}
