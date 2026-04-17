/** Documentation strings for Encore directive elements, used in autocomplete and hover tooltips. */

export const DIRECTIVE_DOCS: Record<string, string> = {
  api:
    "Define an API endpoint.\n\n" +
    "Requires an access modifier (`public`, `private`, or `auth`) as the first option.\n\n" +
    "**Example:**\n" +
    "```go\n" +
    "//encore:api public method=GET path=/users/:id\n" +
    "func GetUser(ctx context.Context, id string) (*User, error) { }\n" +
    "```\n\n" +
    "[Encore docs: Defining APIs](https://encore.dev/docs/go/primitives/defining-apis)",

  service:
    "Mark a struct as an Encore service with dependency injection and lifecycle management.\n\n" +
    "The struct must have a corresponding `initServiceName()` function.\n\n" +
    "**Example:**\n" +
    "```go\n" +
    "//encore:service\n" +
    "type Service struct { }\n" +
    "\n" +
    "func initService() (*Service, error) { return &Service{}, nil }\n" +
    "```\n\n" +
    "[Encore docs: Service Structs](https://encore.dev/docs/go/primitives/service-structs)",

  authhandler:
    "Define an authentication handler that validates incoming requests.\n\n" +
    "The handler receives auth credentials and returns a user ID (and optionally user data).\n\n" +
    "**Example:**\n" +
    "```go\n" +
    "//encore:authhandler\n" +
    "func AuthHandler(ctx context.Context, token string) (auth.UID, error) { }\n" +
    "```\n\n" +
    "[Encore docs: Authentication](https://encore.dev/docs/go/develop/auth)",

  middleware:
    "Define middleware that runs before or after API handlers.\n\n" +
    "Use `global` to apply across all services. Use `target=` to select which APIs the middleware applies to.\n\n" +
    "**Example:**\n" +
    "```go\n" +
    "//encore:middleware global target=tag:cache\n" +
    "func CacheMiddleware(req middleware.Request, next middleware.Next) middleware.Response { }\n" +
    "```\n\n" +
    "[Encore docs: Middleware](https://encore.dev/docs/go/develop/middleware)",
};

export const ACCESS_MODIFIER_DOCS: Record<string, string> = {
  public:
    "Anyone can call the endpoint.\n\n" +
    "[Encore docs: Access Control](https://encore.dev/docs/go/primitives/defining-apis#access-controls)",

  private:
    "Only other services in the app can call the endpoint. Never exposed externally.\n\n" +
    "[Encore docs: Access Control](https://encore.dev/docs/go/primitives/defining-apis#access-controls)",

  auth:
    "Anyone can call the endpoint, but must be authenticated first.\n\n" +
    "[Encore docs: Access Control](https://encore.dev/docs/go/primitives/defining-apis#access-controls)",
};

export const MODIFIER_DOCS: Record<string, string> = {
  raw:
    "**raw** — Handle raw HTTP requests and responses directly, bypassing Encore's automatic " +
    "request/response encoding.\n\n" +
    "The function signature changes to `(w http.ResponseWriter, req *http.Request)`.\n\n" +
    "```go\n" +
    "//encore:api public raw path=/webhook\n" +
    "func Webhook(w http.ResponseWriter, req *http.Request) { }\n" +
    "```",

  sensitive:
    "**sensitive** — Mark the endpoint as sensitive. Encore redacts the entire request and response " +
    "payloads from trace data.\n\n" +
    "```go\n" +
    "//encore:api auth sensitive\n" +
    "```",

  global:
    "**global** — Apply the middleware across all services. Without `global`, the middleware is " +
    "scoped to the service where the middleware is defined.\n\n" +
    "```go\n" +
    "//encore:middleware global target=all\n" +
    "```",
};

export const FIELD_DOCS: Record<string, string> = {
  method:
    "**method** — Specify which HTTP methods the endpoint accepts. " +
    "Multiple methods can be comma-separated.\n\n" +
    "```go\n" +
    "//encore:api public method=GET\n" +
    "//encore:api public method=GET,POST\n" +
    "```",

  path:
    "**path** — Define the URL path for the endpoint. Supports named parameters (`:name`) " +
    "and wildcard parameters (`*name`).\n\n" +
    "```go\n" +
    "//encore:api public method=GET path=/users/:id\n" +
    "//encore:api public method=GET path=/files/*path\n" +
    "```",

  target:
    "**target** — Specify which APIs the middleware applies to. " +
    "Use `all` for all endpoints, or `tag:<name>` to target tagged endpoints.\n\n" +
    "```go\n" +
    "//encore:middleware global target=all\n" +
    "//encore:middleware global target=tag:cache\n" +
    "//encore:middleware global target=tag:cache,tag:auth\n" +
    "```",
};

export const TAG_DOCS =
  "**tag:\\<name\\>** — Assign a tag to the API endpoint. " +
  "Tags are used by middleware `target=tag:<name>` to select which endpoints the middleware applies to. " +
  "Multiple tags can be added to a single endpoint.\n\n" +
  "```go\n" +
  "//encore:api public method=GET path=/data tag:cache tag:public\n" +
  "```\n\n" +
  "[Encore docs: Middleware](https://encore.dev/docs/go/develop/middleware)";

export const TARGET_VALUE_DOCS: Record<string, string> = {
  all: "**all** — Apply the middleware to all API endpoints.",
  "tag:":
    "**tag:\\<name\\>** — Apply the middleware to API endpoints with the specified tag.\n\n" +
    "```go\n" +
    "//encore:middleware global target=tag:cache\n" +
    "```",
};
