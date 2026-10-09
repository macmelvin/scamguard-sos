country.mmdb is DB-IP's free Country Lite database (CC-BY-4.0, see DBIP-LICENSE),
republished monthly as the npm package `@ip-location-db/dbip-country-mmdb` by the
sapics/ip-location-db project (https://github.com/sapics/ip-location-db). It maps
an IP address to a 2-letter ISO country code only -- no city, no coordinates.

To refresh it to the latest monthly build:

  npm view @ip-location-db/dbip-country-mmdb dist-tags.latest
  npm pack @ip-location-db/dbip-country-mmdb@<version>
  tar xzf ip-location-db-dbip-country-mmdb-*.tgz
  cp package/dbip-country.mmdb geo/country.mmdb

Note this file's schema is the project's own flattened `{ country_code }` shape,
not the official MaxMind `{ country: { iso_code } }` one -- server.ts's
geoCountry() checks both so it keeps working if country.mmdb is ever swapped for
an official MaxMind-format database instead.
