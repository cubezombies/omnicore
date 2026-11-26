import type { PageProps } from '../App';
import { StagePage } from './StagePage';

export function Research(props: PageProps) {
  return (
    <StagePage
      {...props}
      title="Research"
      description="Ideas and topics being validated before scripting."
      stages={['idea', 'research']}
      empty="Nothing in research. Add an idea to get started."
      allowCreate
    />
  );
}
