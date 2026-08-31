INSERT INTO credit_plans (slug, name, subtext, credits, base_paise, is_active, is_highlighted, badge, sort_order, queue_stream)
VALUES ('free', 'Free', 'Default plan for new users', 0, 0, TRUE, FALSE, NULL, 0, 'normal')
ON CONFLICT (slug) DO NOTHING;
