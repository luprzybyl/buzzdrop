import os
import sys
from urllib.parse import unquote
from flask import Flask
from app import app as flask_app

def application(environ, start_response):
    # Optionally, handle PATH_INFO encoding issues for some servers
    environ["PATH_INFO"] = unquote(environ["PATH_INFO"]).encode('utf-8').decode('iso-8859-1')
    return flask_app(environ, start_response)
