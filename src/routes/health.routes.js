import express from 'express';
const router = express.Router();
router.get('/health', (req,res)=>res.json({ ok:true, status:'up' }));
export default router;
