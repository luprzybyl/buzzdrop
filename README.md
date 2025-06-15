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

- Files are stored temporarily in the `uploads` directory or in S3, depending on configuration
- Each file is assigned a unique UUID
- Files are automatically deleted after the first download
- File types are restricted to prevent malicious uploads
- Maximum file size is limited to 16MB

## AWS S3 Integration

Buzzdrop supports storing uploaded files in an AWS S3 bucket as a private backend. Downloads are always proxied through the application (users never see S3 URLs).

### Configuration

1. Set the following environment variables (e.g., in your `.env` file):
   ```
   STORAGE_BACKEND=s3
   S3_BUCKET=your-bucket-name
   S3_ACCESS_KEY=your-access-key
   S3_SECRET_KEY=your-secret-key
   S3_REGION=your-region
   ```
   To use local storage, set `STORAGE_BACKEND=local` (default).

2. The S3 bucket must exist and be private. The app will store files under the `uploads/` prefix in the bucket.

### Required AWS IAM Permissions

The IAM user or role used for Buzzdrop must have the following permissions for the target bucket:

```
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::your-bucket-name/uploads/*"
    }
  ]
}
```
- Replace `your-bucket-name` with your actual S3 bucket name.
- The above policy allows uploading, downloading, and deleting files under the `uploads/` prefix only.

### Notes
- The bucket should NOT be public.
- All file downloads are proxied through the app for security and one-time access enforcement.
- S3 credentials should be kept secret and never checked into version control.

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
