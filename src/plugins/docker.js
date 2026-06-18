import { execSync } from 'child_process';

export const name        = 'docker';
export const description = 'Docker container and image management';

export const tools = [
  {
    name: 'ps',
    description: 'List containers.',
    input_schema: {
      type: 'object',
      properties: { all: { type: 'boolean', description: 'Include stopped containers (default: false)' } },
      required: [],
    },
  },
  {
    name: 'logs',
    description: 'Get logs from a container.',
    input_schema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        lines:     { type: 'number', description: 'Number of recent lines to show (default: 50)' },
        follow:    { type: 'boolean', description: 'Not supported — always returns a snapshot' },
      },
      required: ['container'],
    },
  },
  {
    name: 'start',
    description: 'Start a stopped container.',
    input_schema: {
      type: 'object',
      properties: { container: { type: 'string' } },
      required: ['container'],
    },
  },
  {
    name: 'stop',
    description: 'Stop a running container.',
    input_schema: {
      type: 'object',
      properties: { container: { type: 'string' } },
      required: ['container'],
    },
  },
  {
    name: 'restart',
    description: 'Restart a container.',
    input_schema: {
      type: 'object',
      properties: { container: { type: 'string' } },
      required: ['container'],
    },
  },
  {
    name: 'exec',
    description: 'Run a command inside a running container.',
    input_schema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        command:   { type: 'string', description: 'Shell command to run' },
      },
      required: ['container', 'command'],
    },
  },
  {
    name: 'build',
    description: 'Build a Docker image from a Dockerfile.',
    input_schema: {
      type: 'object',
      properties: {
        tag:  { type: 'string', description: 'Image tag (e.g. myapp:latest)' },
        path: { type: 'string', description: 'Build context path (default: .)' },
        file: { type: 'string', description: 'Dockerfile path (default: Dockerfile in context)' },
      },
      required: ['tag'],
    },
  },
  {
    name: 'images',
    description: 'List local Docker images.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'pull',
    description: 'Pull a Docker image from a registry.',
    input_schema: {
      type: 'object',
      properties: { image: { type: 'string' } },
      required: ['image'],
    },
  },
  {
    name: 'remove',
    description: 'Remove a container.',
    input_schema: {
      type: 'object',
      properties: {
        container: { type: 'string' },
        force:     { type: 'boolean', description: 'Force remove running container' },
      },
      required: ['container'],
    },
  },
  {
    name: 'compose_up',
    description: 'Run docker compose up in the current directory.',
    input_schema: {
      type: 'object',
      properties: {
        detach:  { type: 'boolean', description: 'Run in background (default: true)' },
        service: { type: 'string', description: 'Specific service to start (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'compose_down',
    description: 'Run docker compose down.',
    input_schema: {
      type: 'object',
      properties: { volumes: { type: 'boolean', description: 'Also remove volumes' } },
      required: [],
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      cwd: process.cwd(),
      ...opts,
    }).trim();
    return { success: true, output: out || '(no output)' };
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || String(err)).trim();
    return { success: false, output: msg };
  }
}

// ── execute ───────────────────────────────────────────────────────────────────

export async function execute(toolName, args) {
  switch (toolName) {
    case 'ps':
      return run(`docker ps${args.all ? ' -a' : ''} --format "table {{.ID}}\\t{{.Image}}\\t{{.Status}}\\t{{.Names}}"`);

    case 'logs':
      return run(`docker logs --tail ${args.lines || 50} ${args.container}`);

    case 'start':
      return run(`docker start ${args.container}`);

    case 'stop':
      return run(`docker stop ${args.container}`);

    case 'restart':
      return run(`docker restart ${args.container}`);

    case 'exec':
      return run(`docker exec ${args.container} sh -c ${JSON.stringify(args.command)}`);

    case 'build': {
      const file = args.file ? `-f ${JSON.stringify(args.file)}` : '';
      return run(`docker build -t ${args.tag} ${file} ${args.path || '.'}`);
    }

    case 'images':
      return run('docker images --format "table {{.Repository}}\\t{{.Tag}}\\t{{.Size}}\\t{{.CreatedSince}}"');

    case 'pull':
      return run(`docker pull ${args.image}`);

    case 'remove':
      return run(`docker rm${args.force ? ' -f' : ''} ${args.container}`);

    case 'compose_up': {
      const detach = args.detach !== false ? '-d' : '';
      const svc    = args.service || '';
      return run(`docker compose up ${detach} ${svc}`.trim());
    }

    case 'compose_down':
      return run(`docker compose down${args.volumes ? ' -v' : ''}`);

    default:
      return { success: false, output: `Unknown docker tool: ${toolName}` };
  }
}
