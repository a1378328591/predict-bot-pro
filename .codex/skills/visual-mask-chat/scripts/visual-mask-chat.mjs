#!/usr/bin/env node

const [, , operation, ...rawArgs] = process.argv;

function usage() {
  console.error([
    'Usage:',
    '  node visual-mask-chat.mjs encode [text]',
    '  node visual-mask-chat.mjs decode [VM1 payload]',
    '',
    'When text is omitted, it is read from stdin.',
  ].join('\n'));
  process.exitCode = 2;
}

async function readInput() {
  if (rawArgs.length > 0) {
    return rawArgs.join(' ');
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function encode(text) {
  return `VM1:${Buffer.from(text, 'utf8').toString('base64')}`;
}

function decode(payload) {
  if (!payload.startsWith('VM1:')) {
    throw new Error('Expected a VM1 payload beginning with "VM1:".');
  }

  const encoded = payload.slice(4);
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('Invalid VM1 Base64 payload.');
  }

  return Buffer.from(encoded, 'base64').toString('utf8');
}

if (!['encode', 'decode'].includes(operation)) {
  usage();
} else {
  try {
    const input = await readInput();
    process.stdout.write(operation === 'encode' ? encode(input) : decode(input));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
