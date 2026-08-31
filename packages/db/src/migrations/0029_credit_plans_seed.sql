INSERT INTO credit_plans (slug, name, subtext, credits, base_paise, is_active, is_highlighted, badge, sort_order)
VALUES
  ('starter', 'Starter Pack', 'Individual sellers & small stores',  2500,   250000, TRUE, FALSE, NULL,         0),
  ('growth',  'Growth Pack',  'Brands & growing businesses',        5000,   500000, TRUE, TRUE,  'Best Value', 1),
  ('pro',     'Pro Pack',     'Large teams & agencies',             10000, 1000000, TRUE, FALSE, NULL,         2)
ON CONFLICT (slug) DO NOTHING;
