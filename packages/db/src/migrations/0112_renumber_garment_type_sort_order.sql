UPDATE garment_subcategories AS g
SET sort_order = ranked.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY gender_slug ORDER BY sort_order, label) AS rn
  FROM garment_subcategories
) AS ranked
WHERE g.id = ranked.id;
