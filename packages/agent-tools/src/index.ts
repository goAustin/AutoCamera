export type PlanningToolName = 'read-project' | 'propose-storyboard';

export interface PlanningToolDescriptor {
  readonly name: PlanningToolName;
  readonly description: string;
}

export const PHASE_1_PLANNING_TOOLS: readonly PlanningToolDescriptor[] = [
  { name: 'read-project', description: 'Read the current project brief.' },
  {
    name: 'propose-storyboard',
    description: 'Propose a storyboard for later phases.',
  },
];
