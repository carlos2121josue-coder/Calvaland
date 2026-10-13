import app from '../server/src/index.js';

export default function handler(request, response) {
  return app(request, response);
}
