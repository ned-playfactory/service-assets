import morgan from 'morgan';
export const httpLogger = morgan(':method :url :status :res[content-length] - :response-time ms');
export const log = (...a) => console.log('[assets]', ...a);
export const warn = (...a) => console.warn('[assets]', ...a);
export const err = (...a) => console.error('[assets]', ...a);
