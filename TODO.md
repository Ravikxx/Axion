# Axion TODO — next features

- **Upload profile picture** in account settings. Not urgent — nice-to-have polish, not blocking anything.
  Store the image in Cloudflare R2 (or Cloudflare Images for automatic resizing), not D1. Needs: an upload
  endpoint with file-type/size validation, a new R2 bucket + binding, a D1 column for the avatar URL, and
  frontend file-picker UI in settings.html.