// Task template library for Lumen trajectory generation.
// Each template's gen(rng) returns { prompt, setup(dir), verify(dir, ctx) }.
// verify runs in the generator process (not the agent) and must be strict:
// a sample only becomes training data if verify returns true.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// Deterministic PRNG so a run is reproducible from its seed.
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const int  = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// Vary user phrasing so Lumen doesn't overfit to one register.
const style = (rng, core) => pick(rng, [
  core,
  `hey, ${core.charAt(0).toLowerCase()}${core.slice(1)}`,
  `${core} Don't ask questions, just do it.`,
  `quick one: ${core.charAt(0).toLowerCase()}${core.slice(1)}`,
  `Please ${core.charAt(0).toLowerCase()}${core.slice(1)}`,
]);

const sh = (cmd, dir) => execSync(cmd, { cwd: dir, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
const nodeOk = (dir, file) => { try { sh(`node ${file}`, dir); return true; } catch { return false; } };
const read = (dir, f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };

// ── 1. fix-bug: planted bug in a small module, failing test ─────────────────
const BUGS = [
  {
    fn: 'sum',
    bad:  'function sum(arr) { return arr.reduce((a, b) => a + b, 1); }',
    test: `assert.strictEqual(sum([1,2,3]), 6); assert.strictEqual(sum([]), 0);`,
  },
  {
    fn: 'max',
    bad:  'function max(arr) { return arr.reduce((a, b) => Math.min(a, b), -Infinity); }',
    test: `assert.strictEqual(max([3,9,2]), 9); assert.strictEqual(max([-5,-1]), -1);`,
  },
  {
    fn: 'isEven',
    bad:  'function isEven(n) { return n % 2 === 1; }',
    test: `assert.strictEqual(isEven(4), true); assert.strictEqual(isEven(7), false);`,
  },
  {
    fn: 'clamp',
    bad:  'function clamp(n, lo, hi) { return Math.max(hi, Math.min(lo, n)); }',
    test: `assert.strictEqual(clamp(5, 0, 3), 3); assert.strictEqual(clamp(-2, 0, 3), 0); assert.strictEqual(clamp(1, 0, 3), 1);`,
  },
  {
    fn: 'average',
    bad:  'function average(arr) { return arr.reduce((a, b) => a + b, 0) / (arr.length + 1); }',
    test: `assert.strictEqual(average([2,4,6]), 4); assert.strictEqual(average([10]), 10);`,
  },
  {
    fn: 'capitalize',
    bad:  'function capitalize(s) { return s.charAt(0) + s.slice(1).toUpperCase(); }',
    test: `assert.strictEqual(capitalize('hello'), 'Hello'); assert.strictEqual(capitalize('a'), 'A');`,
  },
  {
    fn: 'countVowels',
    bad:  "function countVowels(s) { return (s.match(/[aeio]/gi) || []).length; }",
    test: `assert.strictEqual(countVowels('queue'), 4); assert.strictEqual(countVowels('xyz'), 0);`,
  },
  {
    fn: 'factorial',
    bad:  'function factorial(n) { return n <= 1 ? 1 : n * factorial(n - 2); }',
    test: `assert.strictEqual(factorial(5), 120); assert.strictEqual(factorial(0), 1);`,
  },
];

const fixBug = {
  id: 'fix-bug',
  gen(rng) {
    const bug = pick(rng, BUGS);
    return {
      prompt: style(rng, `The test in test.js is failing. Find the bug in lib.js, fix it, and run the test to confirm it passes.`),
      setup(dir) {
        writeFileSync(join(dir, 'lib.js'), `${bug.bad}\nmodule.exports = { ${bug.fn} };\n`);
        writeFileSync(join(dir, 'test.js'),
          `const assert = require('assert');\nconst { ${bug.fn} } = require('./lib.js');\n${bug.test}\nconsole.log('all tests passed');\n`);
      },
      verify: (dir) => nodeOk(dir, 'test.js'),
    };
  },
};

// ── 2. implement-fn: stub + tests, TDD style ────────────────────────────────
const IMPLS = [
  {
    fn: 'reverseWords', desc: 'reverse the order of words in a string',
    test: `assert.strictEqual(reverseWords('the quick fox'), 'fox quick the'); assert.strictEqual(reverseWords('one'), 'one');`,
  },
  {
    fn: 'uniqueSorted', desc: 'return the unique values of an array, sorted ascending',
    test: `assert.deepStrictEqual(uniqueSorted([3,1,3,2]), [1,2,3]); assert.deepStrictEqual(uniqueSorted([]), []);`,
  },
  {
    fn: 'toSnakeCase', desc: 'convert a camelCase string to snake_case',
    test: `assert.strictEqual(toSnakeCase('helloWorldAgain'), 'hello_world_again'); assert.strictEqual(toSnakeCase('abc'), 'abc');`,
  },
  {
    fn: 'chunk', desc: 'split an array into chunks of size n',
    test: `assert.deepStrictEqual(chunk([1,2,3,4,5], 2), [[1,2],[3,4],[5]]); assert.deepStrictEqual(chunk([], 3), []);`,
  },
  {
    fn: 'romanize', desc: 'convert an integer (1-100) to a roman numeral string',
    test: `assert.strictEqual(romanize(4), 'IV'); assert.strictEqual(romanize(58), 'LVIII'); assert.strictEqual(romanize(90), 'XC');`,
  },
];

const implementFn = {
  id: 'implement-fn',
  gen(rng) {
    const impl = pick(rng, IMPLS);
    return {
      prompt: style(rng, `Implement the ${impl.fn} function in lib.js (it should ${impl.desc}), then run test.js and make sure it passes.`),
      setup(dir) {
        writeFileSync(join(dir, 'lib.js'),
          `// ${impl.fn}: ${impl.desc}\nfunction ${impl.fn}() {\n  throw new Error('not implemented');\n}\nmodule.exports = { ${impl.fn} };\n`);
        writeFileSync(join(dir, 'test.js'),
          `const assert = require('assert');\nconst { ${impl.fn} } = require('./lib.js');\n${impl.test}\nconsole.log('all tests passed');\n`);
      },
      verify: (dir) => nodeOk(dir, 'test.js'),
    };
  },
};

// ── 3. refactor-rename: rename a function across files ──────────────────────
const renameRefactor = {
  id: 'refactor-rename',
  gen(rng) {
    const oldName = pick(rng, ['procData', 'handleStuff', 'doWork', 'runIt', 'calcThing']);
    const newName = pick(rng, ['processRecords', 'normalizeInput', 'transformData', 'computeResult']);
    return {
      prompt: style(rng, `Rename the function ${oldName} to ${newName} everywhere in this project, then run app.js to make sure nothing broke.`),
      setup(dir) {
        writeFileSync(join(dir, 'lib.js'),
          `function ${oldName}(items) {\n  return items.map((x) => x * 2);\n}\nmodule.exports = { ${oldName} };\n`);
        writeFileSync(join(dir, 'app.js'),
          `const { ${oldName} } = require('./lib.js');\nconsole.log(JSON.stringify(${oldName}([1, 2, 3])));\n`);
      },
      verify(dir) {
        const all = read(dir, 'lib.js') + read(dir, 'app.js');
        if (all.includes(oldName) || !all.includes(newName)) return false;
        try { return sh('node app.js', dir).trim() === '[2,4,6]'; } catch { return false; }
      },
    };
  },
};

// ── 4. json-config: edit config values ───────────────────────────────────────
const jsonConfig = {
  id: 'json-config',
  gen(rng) {
    const retries = int(rng, 3, 9);
    const port = int(rng, 3000, 9999);
    return {
      prompt: style(rng, `In config.json, set retries to ${retries}, change the port to ${port}, and turn debug on.`),
      setup(dir) {
        writeFileSync(join(dir, 'config.json'),
          JSON.stringify({ name: 'svc', port: 8080, retries: 1, debug: false, timeoutMs: 5000 }, null, 2));
      },
      verify(dir) {
        try {
          const c = JSON.parse(read(dir, 'config.json'));
          return c.retries === retries && c.port === port && c.debug === true && c.timeoutMs === 5000;
        } catch { return false; }
      },
    };
  },
};

// ── 5. organize-files: move files into folders by type ──────────────────────
const organizeFiles = {
  id: 'organize-files',
  gen(rng) {
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    const mdDir = pick(rng, ['docs', 'notes']);
    const txtDir = pick(rng, ['text', 'plain']);
    return {
      prompt: style(rng, `Organize this folder: move all .md files into a ${mdDir}/ folder and all .txt files into a ${txtDir}/ folder.`),
      setup(dir) {
        for (const n of names.slice(0, 3)) writeFileSync(join(dir, `${n}.md`), `# ${n}\n`);
        for (const n of names.slice(3)) writeFileSync(join(dir, `${n}.txt`), `${n} content\n`);
      },
      verify(dir) {
        return names.slice(0, 3).every((n) => existsSync(join(dir, mdDir, `${n}.md`)) && !existsSync(join(dir, `${n}.md`)))
          && names.slice(3).every((n) => existsSync(join(dir, txtDir, `${n}.txt`)) && !existsSync(join(dir, `${n}.txt`)));
      },
    };
  },
};

// ── 6. write-docs: document a module's exports ───────────────────────────────
const writeDocs = {
  id: 'write-docs',
  gen(rng) {
    const fns = pick(rng, [
      ['parseDate', 'formatDate', 'addDays'],
      ['loadUser', 'saveUser', 'deleteUser'],
      ['encode', 'decode', 'validate'],
    ]);
    return {
      prompt: style(rng, `Read utils.js and write a README.md that documents every exported function with a short description and a usage example.`),
      setup(dir) {
        const body = fns.map((f) => `function ${f}(input) {\n  // ${f} implementation\n  return input;\n}`).join('\n\n');
        writeFileSync(join(dir, 'utils.js'), `${body}\n\nmodule.exports = { ${fns.join(', ')} };\n`);
      },
      verify(dir) {
        const md = read(dir, 'README.md');
        return md.length > 100 && fns.every((f) => md.includes(f));
      },
    };
  },
};

// ── 7. git-commit: change + commit ───────────────────────────────────────────
const gitCommit = {
  id: 'git-commit',
  gen(rng) {
    const version = `1.${int(rng, 1, 9)}.${int(rng, 0, 9)}`;
    return {
      prompt: style(rng, `Bump the version in package.json to ${version} and commit the change with the message "bump to ${version}".`),
      setup(dir) {
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo-pkg', version: '1.0.0' }, null, 2));
        sh('git init -q', dir);
        sh('git -c user.email=gen@axion -c user.name=gen add -A', dir);
        sh('git -c user.email=gen@axion -c user.name=gen commit -qm init', dir);
      },
      verify(dir) {
        try {
          const pkg = JSON.parse(read(dir, 'package.json'));
          if (pkg.version !== version) return false;
          const log = sh('git log --oneline -1', dir);
          const clean = sh('git status --porcelain', dir).trim() === '';
          return log.includes(`bump to ${version}`) && clean;
        } catch { return false; }
      },
    };
  },
};

// ── 8. search-question: answer a question about the codebase ─────────────────
const searchQuestion = {
  id: 'search-question',
  gen(rng) {
    const port = int(rng, 4000, 9899);
    const dbName = pick(rng, ['ordersdb', 'maindb', 'appstore', 'userdata']);
    const which = rng() < 0.5;
    return {
      prompt: style(rng, which
        ? `What port does this server listen on? Look through the code and tell me.`
        : `Which database name does this app connect to? Check the code and tell me.`),
      setup(dir) {
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'server.js'),
          `const config = require('./config.js');\nconst http = require('http');\nhttp.createServer(() => {}).listen(config.PORT);\n`);
        writeFileSync(join(dir, 'src', 'config.js'),
          `module.exports = {\n  PORT: ${port},\n  DB_NAME: '${dbName}',\n  LOG_LEVEL: 'info',\n};\n`);
        writeFileSync(join(dir, 'src', 'db.js'),
          `const { DB_NAME } = require('./config.js');\nmodule.exports = () => 'connect:' + DB_NAME;\n`);
      },
      verify: (dir, ctx) => (ctx.finalText || '').includes(which ? String(port) : dbName),
    };
  },
};

// ── 9. csv-transform: write and run a data conversion script ─────────────────
const csvTransform = {
  id: 'csv-transform',
  gen(rng) {
    const rows = [['ana', int(rng, 50, 99)], ['ben', int(rng, 50, 99)], ['cara', int(rng, 50, 99)]];
    return {
      prompt: style(rng, `Write a script convert.js that reads data.csv and writes out.json containing an array of {name, score} objects (score must be a number). Then run it.`),
      setup(dir) {
        writeFileSync(join(dir, 'data.csv'), `name,score\n${rows.map((r) => r.join(',')).join('\n')}\n`);
      },
      verify(dir) {
        try {
          const out = JSON.parse(read(dir, 'out.json'));
          return Array.isArray(out) && out.length === 3
            && rows.every(([n, s]) => out.some((o) => o.name === n && o.score === s));
        } catch { return false; }
      },
    };
  },
};

// ── 10. fix-suite: one buggy source file breaks one of three tests ───────────
const fixSuite = {
  id: 'fix-suite',
  gen(rng) {
    const rate = int(rng, 5, 25);
    return {
      prompt: style(rng, `Run the tests in this project (node run-tests.js). One is failing — fix the source, not the tests, and re-run until everything passes.`),
      setup(dir) {
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'price.js'),
          `function subtotal(items) { return items.reduce((a, i) => a + i.price * i.qty, 0); }\n` +
          `function withTax(amount, ratePct) { return amount + amount * ratePct; }\n` + // bug: missing /100
          `function discount(amount, pct) { return amount * (1 - pct / 100); }\n` +
          `module.exports = { subtotal, withTax, discount };\n`);
        writeFileSync(join(dir, 'run-tests.js'),
          `const assert = require('assert');\nconst { subtotal, withTax, discount } = require('./src/price.js');\n` +
          `assert.strictEqual(subtotal([{price:10,qty:2},{price:5,qty:1}]), 25); console.log('test 1 ok');\n` +
          `assert.strictEqual(withTax(100, ${rate}), ${100 + rate}); console.log('test 2 ok');\n` +
          `assert.strictEqual(discount(200, 50), 100); console.log('test 3 ok');\n`);
      },
      verify: (dir) => nodeOk(dir, 'run-tests.js'),
    };
  },
};

// ── 11. wire-module: create a module and wire it into the entrypoint ─────────
const wireModule = {
  id: 'wire-module',
  gen(rng) {
    const word = pick(rng, ['nebula', 'quasar', 'photon', 'meson']);
    return {
      prompt: style(rng, `Create a greet.js module exporting a greet(name) function that returns "hello, <name>!" and update index.js to print greet('${word}'). Run it to check the output.`),
      setup(dir) {
        writeFileSync(join(dir, 'index.js'), `// entrypoint\nconsole.log('placeholder');\n`);
      },
      verify(dir) {
        try { return sh('node index.js', dir).trim() === `hello, ${word}!`; } catch { return false; }
      },
    };
  },
};

// ── 12. cli-flag: add a flag to a small CLI ──────────────────────────────────
const cliFlag = {
  id: 'cli-flag',
  gen(rng) {
    const flag = pick(rng, ['--upper', '--shout', '--caps']);
    return {
      prompt: style(rng, `cli.js echoes its argument. Add support for a ${flag} flag that uppercases the output (flag can come before or after the word). Test it with: node cli.js ${flag} hello`),
      setup(dir) {
        writeFileSync(join(dir, 'cli.js'),
          `const args = process.argv.slice(2);\nconsole.log(args.join(' '));\n`);
      },
      verify(dir) {
        try {
          return sh(`node cli.js ${flag} hello`, dir).trim() === 'HELLO'
            && sh('node cli.js world', dir).trim() === 'world';
        } catch { return false; }
      },
    };
  },
};

export const TASKS = [
  fixBug, implementFn, renameRefactor, jsonConfig, organizeFiles,
  writeDocs, gitCommit, searchQuestion, csvTransform, fixSuite,
  wireModule, cliFlag,
];
