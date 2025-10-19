import { promises as fs } from 'fs';
import path from 'path';
export async function ensureDir(d){ await fs.mkdir(d,{recursive:true}); }
export async function writeTextFile(p, content){ await ensureDir(path.dirname(p)); await fs.writeFile(p, content, 'utf8'); }
export function skinsAbsPath(publicDir, relPath){ return path.join(process.cwd(), publicDir, relPath.replace(/^\/+/, '')); }
