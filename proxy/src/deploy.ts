import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WRANGLER_TOML = `name = "__WORKER_NAME__"
main = "index.js"
compatibility_date = "2024-12-18"
compatibility_flags = ["nodejs_compat"]

[durable_objects]
bindings = [
  { name = "TERMINAL_SESSION", class_name = "TerminalSession" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["TerminalSession"]
`;

interface DeployOptions {
  name: string;
  origins: string;
  help: boolean;
}

function printHelp(): void {
  console.log(`green-screen-proxy deploy — Deploy the Cloudflare Worker for browser-to-host connections

Usage: green-screen-proxy deploy [options]

Options:
  --name NAME         Worker name (default: green-screen-worker)
  --origins URL,...   CORS allowed origins, comma-separated (default: * = all)
  -h, --help          Show this help message

Examples:
  npx green-screen-proxy deploy
  npx green-screen-proxy deploy --name my-terminal-worker
  npx green-screen-proxy deploy --origins https://myapp.com,https://staging.myapp.com

Prerequisites:
  - A free Cloudflare account (https://dash.cloudflare.com/sign-up)
  - Wrangler CLI (installed automatically if missing)`);
}

function runCommand(command: string, args: string[], options?: { cwd?: string; stdio?: any }): { ok: boolean; stdout: string } {
  const result = spawnSync(command, args, {
    stdio: options?.stdio ?? 'pipe',
    cwd: options?.cwd,
    encoding: 'utf-8',
  });
  return {
    ok: result.status === 0,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
  };
}

function checkWrangler(): boolean {
  return runCommand('npx', ['wrangler', '--version']).ok;
}

function installWrangler(): void {
  console.log('\nInstalling wrangler...');
  const result = runCommand('npm', ['install', '-g', 'wrangler'], { stdio: 'inherit' });
  if (!result.ok) {
    console.error('Failed to install wrangler. Please install it manually:');
    console.error('  npm install -g wrangler');
    process.exit(1);
  }
  console.log('Wrangler installed successfully.\n');
}

function checkAuth(): boolean {
  const result = runCommand('npx', ['wrangler', 'whoami']);
  return result.ok && !result.stdout.includes('not authenticated');
}

function login(): void {
  console.log('\nYou need to log in to Cloudflare first.\n');
  const result = runCommand('npx', ['wrangler', 'login'], { stdio: 'inherit' });
  if (!result.ok) {
    console.error('Login failed. Please try: npx wrangler login');
    process.exit(1);
  }
}

export function deploy(args: string[]): void {
  const options = parseDeployArgs(args);

  if (options.help) {
    printHelp();
    return;
  }

  console.log('green-screen-proxy deploy\n');

  // Step 1: Check wrangler
  console.log('Checking for wrangler...');
  if (!checkWrangler()) {
    console.log('Wrangler not found.');
    installWrangler();
  } else {
    console.log('Wrangler found.\n');
  }

  // Step 2: Check auth
  console.log('Checking Cloudflare authentication...');
  if (!checkAuth()) {
    login();
  } else {
    console.log('Authenticated.\n');
  }

  // Step 3: Prepare temp directory with worker bundle
  console.log('Preparing worker bundle...');
  const tmpDir = mkdtempSync(join(tmpdir(), 'green-screen-worker-'));

  // Read the pre-built worker bundle
  const workerBundlePath = join(__dirname, 'worker', 'index.js');
  let workerCode: string;
  try {
    workerCode = readFileSync(workerBundlePath, 'utf-8');
  } catch {
    console.error(`Worker bundle not found at ${workerBundlePath}`);
    console.error('This is a packaging error. Please report it at:');
    console.error('  https://github.com/visionbridge-solutions/green-screen-react/issues');
    process.exit(1);
  }

  // Step 4: Inject CORS origins
  workerCode = workerCode.replace('__CORS_ORIGINS_PLACEHOLDER__', options.origins);

  // Write files to temp dir
  writeFileSync(join(tmpDir, 'index.js'), workerCode);
  writeFileSync(join(tmpDir, 'wrangler.toml'), WRANGLER_TOML.replace('__WORKER_NAME__', options.name));

  console.log(`Worker name: ${options.name}`);
  console.log(`CORS origins: ${options.origins}\n`);

  // Step 5: Deploy
  console.log('Deploying to Cloudflare...\n');
  const result = runCommand('npx', ['wrangler', 'deploy'], { cwd: tmpDir, stdio: ['inherit', 'pipe', 'inherit'] });

  if (!result.ok) {
    console.error('\nDeployment failed. Check the error above.');
    process.exit(1);
  }

  // Extract URL from wrangler output
  const urlMatch = result.stdout.match(/https:\/\/[\w.-]+\.workers\.dev/);
  const workerUrl = urlMatch ? urlMatch[0] : null;

  console.log('\nWorker deployed successfully!\n');

  if (workerUrl) {
    console.log(`Worker URL: ${workerUrl}\n`);

    // Try to save URL to .env.local automatically
    const saved = saveWorkerUrl(workerUrl);

    if (saved) {
      console.log(`Saved to ${saved}\n`);
      console.log('Use it in your React app:\n');
      console.log(`  import { GreenScreenTerminal, WebSocketAdapter } from 'green-screen-react';`);
      console.log(`  import 'green-screen-react/styles.css';`);
      console.log('');
      console.log(`  const adapter = new WebSocketAdapter({`);
      console.log(`    workerUrl: process.env.${getEnvVarName(saved)}`);
      console.log(`  });`);
      console.log('');
      console.log(`  <GreenScreenTerminal adapter={adapter} />`);
    } else {
      console.log('Use it in your React app:\n');
      console.log(`  import { GreenScreenTerminal, WebSocketAdapter } from 'green-screen-react';`);
      console.log(`  import 'green-screen-react/styles.css';`);
      console.log('');
      console.log(`  const adapter = new WebSocketAdapter({`);
      console.log(`    workerUrl: '${workerUrl}'`);
      console.log(`  });`);
      console.log('');
      console.log(`  <GreenScreenTerminal adapter={adapter} />`);
    }
  }
}

/**
 * Detect the project framework and save the worker URL to the appropriate .env.local file.
 * Returns the file path if saved, null if detection failed.
 */
function saveWorkerUrl(url: string): string | null {
  const cwd = process.cwd();

  // Check for package.json to detect framework
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return null;

  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return null;
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const envFile = join(cwd, '.env.local');

  // Detect framework and choose env var prefix
  let envVar: string;
  if (deps['next']) {
    envVar = `NEXT_PUBLIC_GREEN_SCREEN_URL=${url}`;
  } else if (deps['vite'] || deps['@vitejs/plugin-react']) {
    envVar = `VITE_GREEN_SCREEN_URL=${url}`;
  } else if (deps['react-scripts']) {
    envVar = `REACT_APP_GREEN_SCREEN_URL=${url}`;
  } else {
    // Generic — use VITE_ as most common
    envVar = `VITE_GREEN_SCREEN_URL=${url}`;
  }

  // Append to .env.local (create if needed, don't overwrite existing)
  try {
    if (existsSync(envFile)) {
      const content = readFileSync(envFile, 'utf-8');
      // Check if already set
      const varName = envVar.split('=')[0];
      if (content.includes(varName)) {
        // Update existing value
        const updated = content.replace(new RegExp(`^${varName}=.*$`, 'm'), envVar);
        writeFileSync(envFile, updated);
      } else {
        appendFileSync(envFile, `\n${envVar}\n`);
      }
    } else {
      writeFileSync(envFile, `${envVar}\n`);
    }
    return envFile;
  } catch {
    return null;
  }
}

function getEnvVarName(envFile: string): string {
  try {
    const content = readFileSync(envFile, 'utf-8');
    const match = content.match(/((?:VITE|NEXT_PUBLIC|REACT_APP)_GREEN_SCREEN_URL)=/);
    return match ? match[1] : 'VITE_GREEN_SCREEN_URL';
  } catch {
    return 'VITE_GREEN_SCREEN_URL';
  }
}

function parseDeployArgs(args: string[]): DeployOptions {
  const options: DeployOptions = {
    name: 'green-screen-worker',
    origins: '*',
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name' && i + 1 < args.length) {
      options.name = args[++i];
    } else if (arg === '--origins' && i + 1 < args.length) {
      options.origins = args[++i];
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    }
  }

  return options;
}
