import Joi from 'joi';
export const generateSchema = Joi.object({
  gameId: Joi.string().min(1).required(),
  role: Joi.string().default('token'),
  player: Joi.number().integer().valid(1,2).required(),
  label: Joi.string().max(6).allow('', null).default(''),
  theme: Joi.object({
    fill: Joi.string().default('#1e90ff'),
    stroke: Joi.string().default('#0c57a0'),
    text: Joi.string().default('#ffffff')
  }).default({}),
  size: Joi.object({
    w: Joi.number().integer().min(24).max(512).default(90),
    h: Joi.number().integer().min(24).max(512).default(90)
  }).default({})
});
