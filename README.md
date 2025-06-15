<p align="center">
  <img src="static/logo.png" alt="Buzzdrop Logo" width="180" />
</p>

# One-Time File Sharing

A simple web application that allows users to share files with one-time download links. Once a file is downloaded, the link becomes invalid and the file is automatically deleted.
Files are stored encrypted and the encryption happens in browser for maximum privacy (neither backend app nor storage admin can open them).

## Features

- One-time download links
- Automatic file deletion after download
- files are stored encrypted
- in-browser enryption
- Modern, responsive UI
- file type support, maximum file size, user accounts configurable in .env
- supporting local storage or S3

## Setup

1. Create a virtual environment (recommended):
```bash
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Run the application:
```bash
python app.py
```

4. Open your browser and navigate to `http://localhost:5000`

## Usage

1. Authenticate
2. upload file giving your password
3. file will be encrypted before upload
4. share download link and password to recipient, preferably via 2 different communication channels
5. When someone downloads the file using the link, it will be automatically deleted and the link will become invalid

## Security Notes

- Files are stored temporarily in the `uploads` directory or in S3, depending on configuration
- Each file is assigned a unique UUID
- Files are automatically deleted after the first download
- File types can be  restricted to prevent malicious uploads
- Maximum file size can be set as parameter

## AWS S3 Integration

Buzzdrop supports storing uploaded files in an AWS S3 bucket as a private backend. Downloads are always proxied through the application (users never see S3 URLs).
see .env file for example configuration

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
