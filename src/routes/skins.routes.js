import express from 'express';
import { generateSchema } from '../utils/validate.js';
import { generateSkin } from '../controllers/skins.controller.js';
import { maybeAuth } from '../middleware/auth.middleware.js';

const router = express.Router();

function validate(schema){
  return (req,res,next)=>{
    const { value, error } = schema.validate(req.body, { abortEarly:false, stripUnknown:true });
    if (error) return res.status(400).json({ ok:false, error:error.message, details:error.details });
    req.valid = value; next();
  };
}

router.post('/generate', maybeAuth, validate(generateSchema), generateSkin);
export default router;
