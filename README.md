<p align="center">
  <img src="static/logo.png" alt="Buzzdrop Logo" width="180" />
</p>

# One-Time File Sharing

A simple web application that allows users to share files with one-time download links. Once a file is downloaded, the link becomes invalid and the file is automatically deleted.

## Features

- File upload with drag-and-drop support
- One-time download links
- Automatic file deletion after download
- Modern, responsive UI
- Support for common file types (TXT, PDF, PNG, JPG, JPEG, GIF, DOC, DOCX, XLS, XLSX)
- Maximum file size: 16MB

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

1. Click the "Upload a file" button or drag and drop a file into the upload area
2. Once uploaded, you'll receive a unique sharing link
3. Share the link with others
4. When someone downloads the file using the link, it will be automatically deleted and the link will become invalid

## Security Notes

- Files are stored temporarily in the `uploads` directory
- Each file is assigned a unique UUID
- Files are automatically deleted after the first download
- File types are restricted to prevent malicious uploads
- Maximum file size is limited to 16MB

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

### Prerequisites

1.  **Install Dependencies**: Ensure all project dependencies, including test libraries, are installed. These are listed in `requirements.txt`:
    ```bash
    pip install -r requirements.txt
    ```
2.  **Environment Variables**: The application uses environment variables for configuration (see `.env.example` if provided, or `app.py` for details). For running tests, the test environment (`tests/conftest.py`) sets up specific configurations, including test users. If you wish to run tests locally and mimic the application's operational environment closely, ensure you have a `.env` file set up as you would for development. However, the automated tests are designed to be self-contained regarding user setup.

### Executing Tests

To run the full suite of unit and integration tests, navigate to the root directory of the project and execute:

```bash
pytest -v
```

This command will automatically discover and run all tests located in the `tests/` directory. The `-v` flag provides verbose output.
