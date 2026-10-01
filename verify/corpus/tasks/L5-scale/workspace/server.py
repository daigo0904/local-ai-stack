from http.server import HTTPServer, BaseHTTPRequestHandler

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()

if __name__ == '__main__':
    HTTPServer(('', 8000), H).serve_forever()
