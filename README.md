<p align="center">
  <img src="static/logo.png" alt="Buzzdrop Logo" width="180" />
</p>

# Buzzdrop: File Sharing That Stings—Just Once! 🐝

**Buzzdrop** is a one-time, self-destructing file drop. Upload a file, get a link, and—BZZT!—the file vanishes after a single download. Your secrets are safe: files are encrypted right in your browser, so not even the server can peek.

## Why Buzzdrop?

- 🐝 **One-Time Download**: Each link is a mayfly—one click and it’s gone!
- 🔒 **In-Browser Encryption**: Your file is locked tight before it ever leaves your device.
- 💥 **Auto-Delete**: Downloaded? Boom, gone. No leftovers.
- ☁️ **Local or S3 Storage**: Choose your hive—local or Amazon S3.
- 👩‍💻 **Configurable**: File types, size limits, and users—tweak in `.env`.
- 😎 **Modern UI**: Slick, responsive, and buzzing with style.

## Getting Buzzing

1. **Install the buzz**:
   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
2. **Start the hive**:
   ```bash
   python app.py
   ```
3. **Fly to**: [http://localhost:5000](http://localhost:5000)

---

## 🐳 Dockerized Buzz (The Fastest Flight!)

Want to get buzzing in a single command? Docker’s your jetpack!

```bash
# Build the hive
docker-compose build

# Let the swarm fly
docker-compose up
```

- Your files & database are safe—volumes are shared with your host.
- App will buzz at [http://localhost:5000](http://localhost:5000)
- Customize with your `.env` as usual!

Stop the swarm with `docker-compose down`—no mess, no leftovers.

---

## How to Use

1. Log in (buzzers only!)
2. Upload your file and set a password.
3. Share the magic link + password (use two channels for max stealth).
4. First download zaps the file from existence.
5. Want another? Rinse and repeat!

## Security Buzz

- Files are stored encrypted—no snooping, even by admins.
- Each file has a unique UUID (no guesswork).
- File types and sizes are configurable for extra sting.
- S3 support: files never exposed, always routed through Buzzdrop.

## S3? No Problem!

Just fill out your `.env` with your S3 details. Buzzdrop will handle the swarm.

---

Ready to buzz? Drop a file and watch it fly—then disappear!  
_Powered by caffeine, code, and a little bit of sting._

## Development

The application is built with:
- Flask (Python web framework)
- Tailwind CSS (for styling)
- Werkzeug (for file handling)
- TinyDB (lightweight JSON database)

## License

MIT License

## Running Tests

This project uses [pytest](https://docs.pytest.org/) for automated testing.

To run the full suite of unit and integration tests, navigate to the root directory of the project and execute:

```bash
pytest -v
```

This command will automatically discover and run all tests located in the `tests/` directory. The `-v` flag provides verbose output.
