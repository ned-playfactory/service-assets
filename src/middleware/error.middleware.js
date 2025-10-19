export function notFound(req,res){ res.status(404).json({ok:false,error:'Not Found'}); }
export function errorHandler(err,req,res,next){
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';
  if (status>=500) console.error('[assets] error:', err);
  res.status(status).json({ ok:false, error: message });
}
