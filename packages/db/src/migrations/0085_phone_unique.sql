CREATE UNIQUE INDEX users_phone_unique ON users (phone) WHERE phone IS NOT NULL;
