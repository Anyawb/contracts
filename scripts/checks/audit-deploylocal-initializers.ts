/**
 * Audit deploylocal.ts deployProxy(...) initializer correctness.
 *
 * Phase 0c (OZ v5 migration):
 * - initializer must exist in ABI (overload => require explicit signature)
 * - initializer args count must match deployProxy args count
 * - if initializer: false, deploylocal.ts must explicitly call initialize(...) later
 *
 * Usage:
 * - pnpm -s hardhat clean && pnpm -s hardhat compile
 * - pnpm -s ts-node --project ./tsconfig.scripts.json scripts/checks/audit-deploylocal-initializers.ts
 */
/* eslint-disable @typescript-eslint/no-var-requires */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const hre = require('hardhat');

type DeployProxyAuditRow = {
  contractName: string;
  deployedKey?: string;
  line: number;
  initializerSetting: { kind: 'default' } | { kind: 'false' } | { kind: 'string'; value: string } | { kind: 'unknown' };
  argsCount: number | null;
  result: 'OK' | 'FAIL';
  abiSignature?: string;
  reason?: string;
  notes?: string;
};

type ObjectLiteralMap = Map<string, ts.ObjectLiteralExpression>;
type ArrayLiteralMap = Map<string, ts.ArrayLiteralExpression>;

function isStringLiteralLike(n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
}

function textOfStringLiteralLike(n: ts.Node): string | null {
  if (!isStringLiteralLike(n)) return null;
  return n.text;
}

function normalizeSig(sig: string): string {
  return sig.replace(/\s+/g, '');
}

function getLineOfNode(sf: ts.SourceFile, n: ts.Node): number {
  const pos = n.getStart(sf, false);
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function isIdentifierNamed(n: ts.Node | undefined, name: string): boolean {
  return !!n && ts.isIdentifier(n) && n.text === name;
}

function getObjectProperty(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | null {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const propName = prop.name;
      if (ts.isIdentifier(propName) && propName.text === key) return prop.initializer;
      if (ts.isStringLiteral(propName) && propName.text === key) return prop.initializer;
    }
  }
  return null;
}

function buildConstLiteralMaps(sf: ts.SourceFile): { objMap: ObjectLiteralMap; arrMap: ArrayLiteralMap } {
  const objMap: ObjectLiteralMap = new Map();
  const arrMap: ArrayLiteralMap = new Map();

  function visit(n: ts.Node) {
    if (ts.isVariableStatement(n)) {
      for (const decl of n.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const id = decl.name.text;
        const init = decl.initializer;
        if (!init) continue;
        if (ts.isObjectLiteralExpression(init)) objMap.set(id, init);
        if (ts.isArrayLiteralExpression(init)) arrMap.set(id, init);
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  return { objMap, arrMap };
}

function resolveObjectLiteral(expr: ts.Expression | undefined, objMap: ObjectLiteralMap): ts.ObjectLiteralExpression | null {
  if (!expr) return null;
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (ts.isIdentifier(expr)) return objMap.get(expr.text) ?? null;
  return null;
}

function resolveArrayLiteral(expr: ts.Expression | undefined, arrMap: ArrayLiteralMap): ts.ArrayLiteralExpression | null {
  if (!expr) return null;
  if (ts.isArrayLiteralExpression(expr)) return expr;
  if (ts.isIdentifier(expr)) return arrMap.get(expr.text) ?? null;
  return null;
}

function findNearestDeployedKey(callExpr: ts.CallExpression): string | undefined {
  // detect: deployed.X = await deployProxy(...)
  let cur: ts.Node | undefined = callExpr;
  while (cur) {
    if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = cur.left;
      if (ts.isPropertyAccessExpression(left) && isIdentifierNamed(left.expression, 'deployed')) {
        return left.name.text;
      }
    }
    cur = cur.parent;
  }
  return undefined;
}

function collectGetContractAtBindings(sf: ts.SourceFile): Map<string, string> {
  // varName -> deployedKey
  const map = new Map<string, string>();

  function visit(n: ts.Node) {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      // const pv = await ethers.getContractAt('PositionView', deployed.PositionView)
      const varName = ts.isIdentifier(n.name) ? n.name.text : null;
      if (!varName) {
        ts.forEachChild(n, visit);
        return;
      }

      const init = n.initializer;
      const awaited = ts.isAwaitExpression(init) ? init.expression : init;
      if (ts.isCallExpression(awaited)) {
        const callee = awaited.expression;
        if (ts.isPropertyAccessExpression(callee) && isIdentifierNamed(callee.expression, 'ethers') && callee.name.text === 'getContractAt') {
          const [, addrArg] = awaited.arguments;
          if (addrArg && ts.isPropertyAccessExpression(addrArg) && isIdentifierNamed(addrArg.expression, 'deployed')) {
            map.set(varName, addrArg.name.text);
          }
        }
      }
    }

    ts.forEachChild(n, visit);
  }

  visit(sf);
  return map;
}

function collectInitializeCalls(sf: ts.SourceFile, varToDeployedKey: Map<string, string>): Map<string, number[]> {
  // deployedKey -> list of initialize arg counts
  const map = new Map<string, number[]>();

  function visit(n: ts.Node) {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'initialize') {
        const obj = callee.expression;
        if (ts.isIdentifier(obj)) {
          const deployedKey = varToDeployedKey.get(obj.text);
          if (deployedKey) {
            const arr = map.get(deployedKey) ?? [];
            arr.push(n.arguments.length);
            map.set(deployedKey, arr);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  }

  visit(sf);
  return map;
}

function formatAbiSignature(name: string, inputs: Array<{ type: string }>): string {
  return `${name}(${inputs.map((i) => i.type).join(',')})`;
}

async function matchInitializerAgainstAbi(params: {
  contractName: string;
  initializer: { kind: 'default' } | { kind: 'false' } | { kind: 'string'; value: string } | { kind: 'unknown' };
  argsCount: number | null;
}): Promise<{ ok: boolean; chosenSig?: string; reason?: string }> {
  const { contractName, initializer, argsCount } = params;

  if (initializer.kind === 'false') {
    return { ok: true, chosenSig: '(disabled)' };
  }

  if (initializer.kind === 'unknown') {
    return { ok: false, reason: 'initializer is not statically resolvable' };
  }

  const initValue = initializer.kind === 'default' ? 'initialize' : initializer.value;
  const initValueNorm = normalizeSig(initValue);

  if (argsCount === null) {
    return { ok: false, reason: 'initializer args are not statically countable (non-literal args array)' };
  }

  let artifact;
  try {
    artifact = await hre.artifacts.readArtifact(contractName);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `artifact not found/readable for "${contractName}" (${msg})` };
  }

  const fns = (artifact.abi as any[]).filter((x) => x && x.type === 'function');

  // explicit signature (e.g. initialize(address))
  if (initValueNorm.includes('(') && initValueNorm.endsWith(')')) {
    const [name] = initValueNorm.split('(');
    const matches = fns
      .filter((x) => typeof x.name === 'string' && x.name === name)
      .map((x) => ({
        sig: normalizeSig(formatAbiSignature(x.name, x.inputs ?? [])),
      }))
      .filter((x) => x.sig === initValueNorm);

    if (!matches.length) {
      return { ok: false, reason: `initializer signature "${initValue}" not found in ABI` };
    }
    // signature implies arg count; still sanity-check count
    const sigArgCount = initValueNorm.slice(initValueNorm.indexOf('(') + 1, -1).trim() === '' ? 0 : initValueNorm.split(',').length;
    if (sigArgCount !== argsCount) {
      return { ok: false, reason: `args length mismatch: deployProxy args=${argsCount}, initializer signature expects ${sigArgCount}` };
    }
    return { ok: true, chosenSig: initValueNorm };
  }

  // name-only initializer (e.g. initialize)
  const nameOnly = initValueNorm;
  const candidates = fns.filter((x) => typeof x.name === 'string' && x.name === nameOnly);
  if (!candidates.length) {
    return { ok: false, reason: `initializer "${nameOnly}" not found in ABI` };
  }

  const arityMatches = candidates.filter((x) => Array.isArray(x.inputs) && x.inputs.length === argsCount);
  if (!arityMatches.length) {
    const arities = [...new Set(candidates.map((x) => (Array.isArray(x.inputs) ? x.inputs.length : -1)))].sort((a, b) => a - b);
    return { ok: false, reason: `no overload matches args length=${argsCount} (available arities=${arities.join(',')})` };
  }
  if (arityMatches.length > 1) {
    const sigs = arityMatches.map((x) => formatAbiSignature(x.name, x.inputs ?? []));
    return { ok: false, reason: `ambiguous overload for args length=${argsCount}; specify signature (candidates: ${sigs.join(' | ')})` };
  }

  return { ok: true, chosenSig: formatAbiSignature(arityMatches[0].name, arityMatches[0].inputs ?? []) };
}

async function main() {
  const deploylocalPath = path.resolve(__dirname, '..', 'deploy', 'deploylocal.ts');
  const code = fs.readFileSync(deploylocalPath, 'utf8');
  const sf = ts.createSourceFile(deploylocalPath, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const { objMap, arrMap } = buildConstLiteralMaps(sf);
  const varToDeployedKey = collectGetContractAtBindings(sf);
  const initCallsByDeployedKey = collectInitializeCalls(sf, varToDeployedKey);

  const rows: DeployProxyAuditRow[] = [];

  function visit(n: ts.Node) {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'deployProxy') {
      const line = getLineOfNode(sf, n);

      const nameArg = n.arguments[0];
      const contractName = nameArg ? textOfStringLiteralLike(nameArg) : null;

      const argsArg = n.arguments[1];
      const argsArr = resolveArrayLiteral(argsArg, arrMap);
      const argsCount = argsArr ? argsArr.elements.length : argsArg ? null : 0;

      const optsArg = n.arguments[2];
      const optsObj = resolveObjectLiteral(optsArg, objMap);

      let initializerSetting: DeployProxyAuditRow['initializerSetting'] = { kind: 'default' };
      if (optsArg && !optsObj) {
        initializerSetting = { kind: 'unknown' };
      } else if (optsObj) {
        const initProp = getObjectProperty(optsObj, 'initializer');
        if (initProp) {
          if (initProp.kind === ts.SyntaxKind.FalseKeyword) initializerSetting = { kind: 'false' };
          else if (isStringLiteralLike(initProp)) initializerSetting = { kind: 'string', value: initProp.text };
          else initializerSetting = { kind: 'unknown' };
        }
      }

      const deployedKey = findNearestDeployedKey(n);

      const row: DeployProxyAuditRow = {
        contractName: contractName ?? '(non-literal)',
        deployedKey,
        line,
        initializerSetting,
        argsCount,
        result: 'FAIL',
      };

      rows.push(row);
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);

  // Evaluate rows
  let failCount = 0;
  for (const row of rows) {
    if (row.contractName === '(non-literal)') {
      row.result = 'FAIL';
      row.reason = 'deployProxy contract name is not a string literal; cannot audit reliably';
      failCount += 1;
      continue;
    }

    // initializer disabled: enforce empty deployProxy args and require later explicit initialize call
    if (row.initializerSetting.kind === 'false') {
      if (row.argsCount === null) {
        row.result = 'FAIL';
        row.reason = 'initializer=false but args array is not statically countable';
        failCount += 1;
        continue;
      }
      if (row.argsCount !== 0) {
        row.result = 'FAIL';
        row.reason = `initializer=false but deployProxy args length=${row.argsCount} (expected 0)`;
        failCount += 1;
        continue;
      }

      if (!row.deployedKey) {
        row.result = 'FAIL';
        row.reason = 'initializer=false but could not map this deployment to deployed.<Key> assignment';
        failCount += 1;
        continue;
      }

      const initCalls = initCallsByDeployedKey.get(row.deployedKey) ?? [];
      if (!initCalls.length) {
        row.result = 'FAIL';
        row.reason = `initializer=false but no explicit initialize(...) call found for deployed.${row.deployedKey}`;
        failCount += 1;
        continue;
      }

      // Also validate the later initialize(...) call against ABI by arg count.
      const initArgsCount = initCalls[0];
      const m = await matchInitializerAgainstAbi({
        contractName: row.contractName,
        initializer: { kind: 'default' },
        argsCount: initArgsCount,
      });
      if (!m.ok) {
        row.result = 'FAIL';
        row.abiSignature = m.chosenSig;
        row.reason = `post-deploy initialize(...) check failed: ${m.reason}`;
        failCount += 1;
        continue;
      }

      row.result = 'OK';
      row.abiSignature = m.chosenSig;
      row.notes = `initializer=false; found initialize(${initArgsCount} args) later`;
      continue;
    }

    const m = await matchInitializerAgainstAbi({
      contractName: row.contractName,
      initializer: row.initializerSetting.kind === 'string' ? row.initializerSetting : row.initializerSetting.kind === 'default' ? { kind: 'default' } : { kind: 'unknown' },
      argsCount: row.argsCount,
    });

    if (!m.ok) {
      row.result = 'FAIL';
      row.reason = m.reason;
      failCount += 1;
      continue;
    }

    row.result = 'OK';
    row.abiSignature = m.chosenSig;
  }

  // Output markdown report
  const header = [
    '| # | line | deployedKey | contract | initializer | argsLen | abi signature | result | notes |',
    '|---:|---:|---|---|---|---:|---|---|---|',
  ];
  const lines: string[] = [...header];
  rows.forEach((r, i) => {
    const initText =
      r.initializerSetting.kind === 'default'
        ? '(default: initialize)'
        : r.initializerSetting.kind === 'false'
          ? 'false'
          : r.initializerSetting.kind === 'string'
            ? r.initializerSetting.value
            : '(unknown)';
    const argsLen = r.argsCount === null ? 'unknown' : String(r.argsCount);
    const abiSig = r.abiSignature ?? '';
    const notes = r.reason ?? r.notes ?? '';
    lines.push(
      `| ${i + 1} | ${r.line} | ${r.deployedKey ?? ''} | ${r.contractName} | ${initText} | ${argsLen} | ${abiSig} | ${r.result} | ${notes.replace(/\|/g, '\\|')} |`
    );
  });

  console.log('\n## deploylocal deployProxy initializer audit\n');
  console.log(lines.join('\n'));
  console.log(`\nSummary: OK=${rows.length - failCount}, FAIL=${failCount}, TOTAL=${rows.length}\n`);

  if (failCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

