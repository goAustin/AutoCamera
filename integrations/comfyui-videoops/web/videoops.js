import { app } from '../../scripts/app.js';
import { createVideoOpsBridge } from './bridge-runtime.js';

let bridge;

app.registerExtension({
  name: 'h3.videoops.managed-bridge',
  commands: [
    {
      id: 'h3.videoops.generate-managed',
      label: 'Generate managed',
      function: () => bridge?.exportCurrentWorkflow(),
    },
  ],
  menuCommands: [
    {
      path: ['Extensions', 'H3 VideoOps'],
      commands: ['h3.videoops.generate-managed'],
    },
  ],
  async setup() {
    bridge = createVideoOpsBridge({ app });
  },
});
