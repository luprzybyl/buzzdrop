# Docker Setup for File Sharing Application

This directory contains Docker configuration files for deploying the file sharing application in a production environment.

## Structure

- `Dockerfile`: Defines the container image for the application
- `docker-compose.yml`: Orchestrates the application services
- `nginx/`: Contains Nginx configuration for reverse proxy

## Production Deployment

### Prerequisites

- Docker and Docker Compose installed on your server
- Basic understanding of Docker and containerization

### Configuration

1. **Environment Variables**

   The application uses environment variables for configuration. You can set these in a `.env` file in the same directory as your `docker-compose.yml` file:

   ```
   FLASK_USER_1=admin:your_secure_password:true
   FLASK_USER_2=user:another_secure_password:false
   ```

2. **SSL Certificates (Optional)**

   For HTTPS support:
   
   - Create a directory `docker/nginx/ssl/`
   - Add your SSL certificates (`cert.pem` and `key.pem`)
   - Uncomment the HTTPS section in `nginx.conf`

### Deployment Steps

1. **Build and start the containers**

   ```bash
   cd /path/to/file-sharing
   docker-compose -f docker/docker-compose.yml up -d
   ```

2. **Verify the deployment**

   ```bash
   docker-compose -f docker/docker-compose.yml ps
   ```

3. **View logs**

   ```bash
   docker-compose -f docker/docker-compose.yml logs -f
   ```

### Data Persistence

The application uses Docker volumes for data persistence:

- `file-sharing-uploads`: Stores uploaded files
- `file-sharing-db`: Stores the database file

These volumes persist even if containers are removed.

### Security Considerations

1. **Change default passwords** in the `.env` file
2. **Enable HTTPS** by configuring SSL certificates
3. **Restrict access** to your server using a firewall
4. **Regularly update** your Docker images

## Scaling and Maintenance

### Updating the Application

```bash
# Pull latest code changes
git pull

# Rebuild and restart containers
docker-compose -f docker/docker-compose.yml up -d --build
```

### Backup

```bash
# Backup volumes
docker run --rm -v file-sharing-uploads:/source -v $(pwd)/backups:/backup alpine tar -czf /backup/uploads-backup-$(date +%Y%m%d).tar.gz -C /source .
docker run --rm -v file-sharing-db:/source -v $(pwd)/backups:/backup alpine tar -czf /backup/db-backup-$(date +%Y%m%d).tar.gz -C /source .
```
