#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// --- Helpers ---

function sanitizeName(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '_')
    .trim();
}

function urlToString(url) {
  if (typeof url === 'string') return url;
  return url?.raw || '';
}

function getAuthType(auth) {
  if (!auth) return 'inherit';
  switch (auth.type) {
    case 'bearer': return 'bearer';
    case 'basic':  return 'basic';
    case 'noauth': return 'none';
    default:       return 'inherit';
  }
}

function getBearerToken(auth) {
  if (auth?.type !== 'bearer') return '{{access_token}}';
  const bearer = auth.bearer || [];
  return bearer.find(b => b.key === 'token')?.value || '{{access_token}}';
}

function getBodyInfo(body) {
  if (!body) return { type: 'none', content: '' };
  switch (body.mode) {
    case 'raw': {
      const lang = body.options?.raw?.language;
      const raw = body.raw || '';
      // Si no tiene language definido, detectar por contenido
      const isJson = lang === 'json' || (!lang && raw.trimStart().startsWith('{') || (!lang && raw.trimStart().startsWith('[')));
      return {
        type: isJson ? 'json' : 'text',
        content: raw,
      };
    }
    case 'formdata':
      return { type: 'multipart-form', content: body.formdata || [] };
    case 'urlencoded':
      return { type: 'form-urlencoded', content: body.urlencoded || [] };
    case 'graphql':
      return { type: 'graphql', content: body.graphql || {} };
    default:
      return { type: 'none', content: '' };
  }
}

// Convert Postman pm.* API to Bruno equivalents
function convertScript(scriptObj) {
  if (!scriptObj) return '';
  const exec = scriptObj.exec;
  let code = Array.isArray(exec) ? exec.join('\n') : (exec || '');

  return code
    .replace(/pm\.response\.json\(\)/g, 'res.getBody()')
    .replace(/pm\.collectionVariables\.set\(([^)]+)\)/g, 'bru.setVar($1)')
    .replace(/pm\.collectionVariables\.get\(([^)]+)\)/g, 'bru.getVar($1)')
    .replace(/pm\.variables\.set\(([^)]+)\)/g, 'bru.setVar($1)')
    .replace(/pm\.variables\.get\(([^)]+)\)/g, 'bru.getVar($1)')
    .replace(/pm\.environment\.set\(([^)]+)\)/g, 'bru.setEnvVar($1)')
    .replace(/pm\.environment\.get\(([^)]+)\)/g, 'bru.getEnvVar($1)')
    .replace(/pm\.globals\.set\(([^)]+)\)/g, 'bru.setVar($1)')
    .replace(/pm\.globals\.get\(([^)]+)\)/g, 'bru.getVar($1)')
    .replace(/pm\.test\(/g, 'test(')
    .replace(/pm\.expect\(/g, 'expect(')
    .replace(/pm\.response\.to\.have\.status\(([^)]+)\)/g, 'expect(res.getStatus()).to.equal($1)')
    .replace(/pm\.response\.code\b/g, 'res.getStatus()')
    .replace(/pm\.response\.text\(\)/g, 'res.getBody()');
}

function parseEvents(events) {
  let preRequest = '';
  let postResponse = '';
  for (const ev of (events || [])) {
    const code = convertScript(ev.script);
    if (ev.listen === 'prerequest') preRequest = code;
    if (ev.listen === 'test')       postResponse = code;
  }
  return { preRequest, postResponse };
}

// --- .bru file builder ---

function buildBruFile(item) {
  const req    = item.request;
  const method = (req.method || 'GET').toLowerCase();
  const url    = urlToString(req.url);
  const auth   = getAuthType(req.auth);
  const body   = getBodyInfo(req.body);
  const headers = (req.header || []).filter(h => !h.disabled);

  const lines = [];

  // meta
  lines.push('meta {');
  lines.push(`  name: ${item.name}`);
  lines.push('  type: http');
  lines.push('}');
  lines.push('');

  // method block
  const bodyLabel = body.type === 'none' ? 'none' : body.type;
  lines.push(`${method} {`);
  lines.push(`  url: ${url}`);
  lines.push(`  body: ${bodyLabel}`);
  lines.push(`  auth: ${auth}`);
  lines.push('}');
  lines.push('');

  // auth:bearer block (only when explicitly set per-request)
  if (auth === 'bearer') {
    lines.push('auth:bearer {');
    lines.push(`  token: ${getBearerToken(req.auth)}`);
    lines.push('}');
    lines.push('');
  }

  // headers
  if (headers.length > 0) {
    lines.push('headers {');
    for (const h of headers) {
      lines.push(`  ${h.key}: ${h.value}`);
    }
    lines.push('}');
    lines.push('');
  }

  // body
  if (body.type === 'json' || body.type === 'text') {
    lines.push(`body:${body.type} {`);
    lines.push(body.content);
    lines.push('}');
    lines.push('');
  } else if (body.type === 'multipart-form') {
    lines.push('body:multipart-form {');
    for (const p of body.content) {
      if (p.type === 'file') {
        lines.push(`  ${p.key}: @file(${p.src || ''})`);
      } else {
        lines.push(`  ${p.key}: ${p.value || ''}`);
      }
    }
    lines.push('}');
    lines.push('');
  } else if (body.type === 'form-urlencoded') {
    lines.push('body:form-urlencoded {');
    for (const p of body.content) {
      lines.push(`  ${p.key}: ${p.value || ''}`);
    }
    lines.push('}');
    lines.push('');
  } else if (body.type === 'graphql') {
    lines.push('body:graphql {');
    lines.push(`  query: ${body.content.query || ''}`);
    lines.push('}');
    lines.push('');
  }

  // scripts
  const { preRequest, postResponse } = parseEvents(item.event);

  if (preRequest.trim()) {
    lines.push('script:pre-request {');
    lines.push(preRequest);
    lines.push('}');
    lines.push('');
  }

  if (postResponse.trim()) {
    lines.push('script:post-response {');
    lines.push(postResponse);
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

// --- Recursive folder processor ---

function processItems(items, outDir, counters) {
  fs.mkdirSync(outDir, { recursive: true });

  for (const item of items) {
    if (item.item) {
      // Folder
      const folderDirName = sanitizeName(item.name);
      const folderDir = path.join(outDir, folderDirName);

      // folder.bru (for folder metadata / description)
      const folderBru = [
        'meta {',
        `  name: ${item.name}`,
        '  type: folder',
        '}',
        '',
      ].join('\n');

      fs.mkdirSync(folderDir, { recursive: true });
      fs.writeFileSync(path.join(folderDir, 'folder.bru'), folderBru, 'utf8');

      processItems(item.item, folderDir, counters);
    } else if (item.request) {
      // Request
      const fileName = sanitizeName(item.name) + '.bru';
      const content  = buildBruFile(item);
      fs.writeFileSync(path.join(outDir, fileName), content, 'utf8');
      counters.requests++;
    }
  }
}

// --- Main converter ---

function convertCollection(inputFile, baseOut) {
  const raw  = fs.readFileSync(inputFile, 'utf8');
  const data = JSON.parse(raw);

  const collectionDir = path.join(baseOut, sanitizeName(data.info.name));

  // bruno.json
  fs.mkdirSync(collectionDir, { recursive: true });
  const brunoJson = {
    version: '1',
    name: data.info.name,
    type: 'collection',
    ignore: [],
  };
  fs.writeFileSync(
    path.join(collectionDir, 'bruno.json'),
    JSON.stringify(brunoJson, null, 2),
    'utf8'
  );

  // environments/dev.bru
  const vars = (data.variable || []).filter(v => v.key && !v.disabled);
  if (vars.length > 0) {
    const envDir = path.join(collectionDir, 'environments');
    fs.mkdirSync(envDir, { recursive: true });

    const envLines = ['vars {'];
    for (const v of vars) {
      envLines.push(`  ${v.key}: ${v.value ?? ''}`);
    }
    envLines.push('}', '');

    fs.writeFileSync(path.join(envDir, 'dev.bru'), envLines.join('\n'), 'utf8');
  }

  // Collection-level auth → root folder.bru
  if (data.auth) {
    const authType = getAuthType(data.auth);
    const rootFolderLines = [
      'meta {',
      `  name: ${data.info.name}`,
      '  type: folder',
      '}',
      '',
    ];
    if (authType === 'bearer') {
      rootFolderLines.push(
        'auth {',
        '  mode: bearer',
        '}',
        '',
        'auth:bearer {',
        `  token: ${getBearerToken(data.auth)}`,
        '}',
        ''
      );
    }
    fs.writeFileSync(
      path.join(collectionDir, 'folder.bru'),
      rootFolderLines.join('\n'),
      'utf8'
    );
  }

  // Collection-level scripts (pre/post) → informational comment file
  const { preRequest, postResponse } = parseEvents(data.event);
  if (preRequest.trim() || postResponse.trim()) {
    const scriptNote = [
      '// NOTE: These were collection-level scripts in Postman.',
      '// Bruno does not support collection-level scripts directly.',
      '// Add them to individual requests or folder scripts as needed.',
      '',
      preRequest.trim() ? `// PRE-REQUEST:\n${preRequest}` : '',
      postResponse.trim() ? `// POST-RESPONSE:\n${postResponse}` : '',
    ].filter(Boolean).join('\n');

    fs.writeFileSync(
      path.join(collectionDir, 'collection-scripts.note.js'),
      scriptNote,
      'utf8'
    );
  }

  // Process all items
  const counters = { requests: 0 };
  processItems(data.item, collectionDir, counters);

  console.log(`✓ ${data.info.name}`);
  console.log(`  → ${collectionDir}`);
  console.log(`  → ${counters.requests} requests convertidos`);
  console.log('');
}

// --- Run ---

const BASE = path.dirname(__filename);

convertCollection(path.join(BASE, 'Racket Pulse.postman_collection.json'), BASE);
convertCollection(path.join(BASE, 'RacketPulse Admin.postman_collection.json'), BASE);

console.log('Conversión completa. Abre las carpetas generadas en Bruno.');
