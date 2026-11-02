import type { FastifyInstance } from 'fastify';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { httpError } from './auth.js';

const files = new Map([
  ['traffic-agent-linux-amd64', 'application/octet-stream'],
  ['traffic-agent-linux-arm64', 'application/octet-stream'],
  ['SHA256SUMS', 'text/plain; charset=utf-8'],
  ['install-agent.py', 'text/plain; charset=utf-8'],
]);

export function installAgentDownloads(app: FastifyInstance, directory: string) {
  const root = resolve(directory);
  app.get<{ Params: { file: string } }>('/downloads/agent/:file', async (req, reply) => {
    const filename = req.params.file;
    const contentType = files.get(filename);
    if (!contentType) throw httpError(404, '分发文件不存在');
    const handle = await open(resolve(root, filename), 'r').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw httpError(503, 'Agent 分发文件尚未打包，请构建新版中心镜像');
      throw error;
    });
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw httpError(503, 'Agent 分发文件不可用');
      reply.type(contentType)
        .header('Content-Length', stat.size)
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Cache-Control', 'no-cache');
    } catch (error) {
      await handle.close();
      throw error;
    }
    return reply.send(handle.createReadStream());
  });
}
