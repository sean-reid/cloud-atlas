CREATE INDEX availability_signal_observed ON availability_signal(observed_at);
CREATE INDEX availability_signal_provider_time ON availability_signal(provider_slug, observed_at);
CREATE INDEX availability_signal_family_time ON availability_signal(provider_slug, sku_family, observed_at);
CREATE INDEX availability_signal_sku_time ON availability_signal(provider_slug, region_code, sku, observed_at);
