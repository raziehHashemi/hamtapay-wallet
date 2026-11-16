/* eslint-disable no-console */
/**
 * Writes docs/openapi.json and docs/openapi.yaml from the code (no database needed: Nest "preview" mode
 * builds the module graph without instantiating providers).   npm run openapi:export
 */
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { buildOpenApiConfig } from '../src/app.setup';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { preview: true, abortOnError: false, logger: false });
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  const out = join(__dirname, '..', 'docs');
  writeFileSync(join(out, 'openapi.json'), JSON.stringify(document, null, 2) + '\n');
  writeFileSync(join(out, 'openapi.yaml'), toYaml(document) + '\n');
  console.log(`wrote docs/openapi.json and docs/openapi.yaml (${Object.keys(document.paths).length} paths)`);
  await app.close();
}

/** Minimal JSON -> YAML (the document only contains plain JSON values). */
function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value
      .map((v) => {
        const rendered = toYaml(v, indent + 1);
        return isScalar(v) ? `${pad}- ${rendered}` : `${pad}-\n${rendered}`;
      })
      .join('\n');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return '{}';
    return entries
      .map(([k, v]) => {
        const key = /^[A-Za-z0-9_.\-/{}]+$/.test(k) && !/^\d+$/.test(k) ? k : JSON.stringify(k);
        if (isScalar(v) || (Array.isArray(v) && !v.length) || (isObject(v) && !Object.keys(v).length)) {
          return `${pad}${key}: ${toYaml(v, indent + 1)}`;
        }
        return `${pad}${key}:\n${toYaml(v, indent + 1)}`;
      })
      .join('\n');
  }
  return JSON.stringify(value);
}
const isScalar = (v: unknown) => v === null || typeof v !== 'object';
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
