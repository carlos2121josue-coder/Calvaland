import app from '../server/src/index.js';

export default function handler(request, response) {
  const requestUrl = new URL(request.url, 'http://localhost');
  const originalPath = requestUrl.searchParams.get('__mesalista_path');

  if (originalPath?.startsWith('/api/') && !originalPath.includes('..')) {
    requestUrl.searchParams.delete('__mesalista_path');
    request.url = `${originalPath}${requestUrl.search}`;
  }

  return app(request, response);
}
