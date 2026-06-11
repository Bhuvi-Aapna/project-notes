# Jira Integration - Quick API Reference

## Quick Start

### 1. Setup OAuth (One-time)

#### Generate Authorization URL
```http
POST /api/PortalIntegration/oauth/generate-auth-url
Content-Type: application/json
Authorization: Bearer {YOUR_JWT_TOKEN}

{
  "portalName": "Jira",
  "clientID": "YOUR_OAUTH_CLIENT_ID",
  "redirectUri": "https://your-app.com/oauth/callback"
}
```

**Response:**
```json
{
  "success": true,
  "authUrl": "https://auth.atlassian.com/authorize?...",
  "state": "abc123..."
}
```

**Next Step:** Redirect user to `authUrl`

---

#### Exchange Code for Token
```http
POST /api/PortalIntegration/oauth/generate-token
Content-Type: application/json
Authorization: Bearer {YOUR_JWT_TOKEN}

{
  "portalName": "Jira",
  "clientID": "YOUR_OAUTH_CLIENT_ID",
  "clientSecret": "YOUR_OAUTH_CLIENT_SECRET",
  "redirectUri": "https://your-app.com/oauth/callback",
  "authCode": "CODE_FROM_CALLBACK"
}
```

**Response:**
```json
{
  "success": true,
  "accessToken": "eyJhbGci...",
  "refreshToken": "refresh_token_value",
  "expiresIn": 3600
}
```

---

## Common Operations

### Get Users

```http
POST /api/PortalIntegration/users
Content-Type: application/json
Authorization: Bearer {YOUR_JWT_TOKEN}

{
  "portalName": "Jira",
  "baseUrl": "https://your-domain.atlassian.net",
  "authToken": "ACCESS_TOKEN"
}
```

---

### Search User by Email

```http
POST /api/PortalIntegration/users/by-property
Content-Type: application/json
Authorization: Bearer {YOUR_JWT_TOKEN}

{
  "portalName": "Jira",
  "baseUrl": "https://your-domain.atlassian.net",
  "authToken": "ACCESS_TOKEN",
  "adminEmail": "user@example.com"
}
```

---

### Get User's Open Tasks

```http
POST /api/PortalIntegration/tasks
Content-Type: application/json
Authorization: Bearer {YOUR_JWT_TOKEN}

{
  "portalName": "Jira",
  "baseUrl": "https://your-domain.atlassian.net",
  "authToken": "ACCESS_TOKEN",
  "id": "JIRA_USER_ACCOUNT_ID"
}
```

**Returns:** All tasks assigned to user that are not in "Done" status

---

### Update Issue

```http
PUT /api/PortalIntegration/tasks/{issueKey}
Content-Type: application/json
Authorization: Bearer {YOUR_JWT_TOKEN}

{
  "portalName": "Jira",
  "baseUrl": "https://your-domain.atlassian.net",
  "authToken": "ACCESS_TOKEN",
  "id": "PROJ-123",
  "body": {
    "fields": {
      "summary": "New title",
      "description": "New description",
      "duedate": "2024-12-31"
    }
  }
}
```

---

### Log Work (Time Entry)

```http
POST /api/PortalIntegration/time-entries
Content-Type: application/json
Authorization: Bearer {YOUR_JWT_TOKEN}

{
  "portalName": "Jira",
  "baseUrl": "https://your-domain.atlassian.net",
  "authToken": "ACCESS_TOKEN",
  "id": "PROJ-123",
  "body": {
    "comment": "Work description",
    "started": "2024-01-15T09:00:00.000+0000",
    "timeSpentSeconds": 14400
  }
}
```

**Time Conversion:**
- 1 hour = 3600 seconds
- 4 hours = 14400 seconds
- 8 hours = 28800 seconds

---

## JQL Examples

### Basic Queries

```
assignee = currentUser()
```
Get all issues assigned to the current user

```
assignee = "john.doe@example.com" AND status = "In Progress"
```
Get in-progress issues for specific user

```
project = "MYPROJECT" AND updated >= -7d
```
Get issues updated in last 7 days

```
assignee = currentUser() AND statusCategory != Done
```
Get all open tasks (used by GetTaskByProperty)

### Advanced Queries

```
assignee = currentUser() AND due <= 7d AND statusCategory != Done
```
Get tasks due within next 7 days

```
project = "MYPROJECT" AND Sprint in openSprints()
```
Get issues in current sprint

```
assignee = currentUser() AND timeSpent > 0 AND updated >= -1d
```
Get tasks with logged time today

---

## Time Conversions

### Hours to Seconds (for API)
```csharp
int seconds = hours * 3600;

// Examples:
// 1 hour   = 3600 seconds
// 2.5 hours = 9000 seconds
// 8 hours  = 28800 seconds
```

### Seconds to Hours (from API)
```csharp
double hours = seconds / 3600.0;

// Examples:
// 3600 seconds  = 1 hour
// 9000 seconds  = 2.5 hours
// 28800 seconds = 8 hours
```

---

## Date Formats

### ISO 8601 (for worklogs)
```
2024-01-15T09:00:00.000+0000
```

### Date Only (for due dates)
```
2024-12-31
```

### C# DateTime to Jira Format
```csharp
// For worklogs
var jiraDateTime = dateTime.ToUniversalTime()
    .ToString("yyyy-MM-ddTHH:mm:ss.fff+0000");

// For due dates
var jiraDueDate = dateTime.ToString("yyyy-MM-dd");
```

---

## Status Categories

Jira groups statuses into 3 categories:

| Category | Examples | IsClosed |
|----------|----------|----------|
| To Do | Backlog, To Do, Open | false |
| In Progress | In Progress, In Review | false |
| Done | Done, Closed, Resolved | true |

**Check if issue is closed:**
```csharp
bool isClosed = issue.Fields.Status.StatusCategory.Key == "done";
```

---

## Common Field Names

### Issue Fields
| Field | API Name | Type |
|-------|----------|------|
| Summary (Title) | `summary` | string |
| Description | `description` | string |
| Due Date | `duedate` | string (yyyy-MM-dd) |
| Time Estimate | `timeestimate` | int (seconds) |
| Assignee | `assignee` | object |
| Status | `status` | object |
| Priority | `priority` | object |

### Update Example
```json
{
  "fields": {
    "summary": "Updated title",
    "description": "Updated description",
    "duedate": "2024-12-31",
    "timeestimate": 28800
  }
}
```

---

## Error Codes

| Code | Meaning | Solution |
|------|---------|----------|
| 401 | Unauthorized | Check access token |
| 403 | Forbidden | Check user permissions |
| 404 | Not Found | Verify issue key exists |
| 429 | Rate Limited | Slow down requests |
| 500 | Server Error | Check Jira status |

---

## Rate Limits

**Jira Cloud Limits:**
- 10 requests/second per user
- 600 requests/minute per IP

**Best Practices:**
- Add 100ms delay between batches
- Use pagination (max 50-100 results)
- Cache frequently accessed data
- Monitor rate limit headers

---

## OAuth Token Lifecycle

```
???????????????????????????????????????????????????
? 1. Generate Auth URL                            ?
?    Valid: Immediate use                         ?
???????????????????????????????????????????????????
                   ?
???????????????????????????????????????????????????
? 2. User Authorizes                              ?
?    Returns: Authorization Code                  ?
?    Valid: 60 seconds                            ?
???????????????????????????????????????????????????
                   ?
???????????????????????????????????????????????????
? 3. Exchange for Token                           ?
?    Returns: Access Token + Refresh Token        ?
?    Access Token Valid: 3600 seconds (1 hour)    ?
?    Refresh Token Valid: Until revoked           ?
???????????????????????????????????????????????????
                   ?
???????????????????????????????????????????????????
? 4. Use Access Token                             ?
?    Check expiry before each use                 ?
???????????????????????????????????????????????????
                   ?
???????????????????????????????????????????????????
? 5. Token Expires?                               ?
?    Use Refresh Token to get new Access Token    ?
???????????????????????????????????????????????????
```

---

## Configuration Checklist

### OAuth App Setup (Atlassian Developer Console)
- [ ] Create OAuth 2.0 app
- [ ] Add redirect URI
- [ ] Note Client ID
- [ ] Note Client Secret
- [ ] Add required scopes:
  - [ ] `read:jira-work`
  - [ ] `read:jira-user`
  - [ ] `write:jira-work`
  - [ ] `offline_access`

### Database Setup
- [ ] Add PortalConfiguration document
  - [ ] Set `portalName` to "Jira"
  - [ ] Set `portalURL` to Jira instance URL
  - [ ] Set `isActive` to true

- [ ] Add PortalOrgApiConfig document
  - [ ] Link to PortalConfiguration
  - [ ] Add OAuth credentials
  - [ ] Set token expiry

### Application Setup
- [ ] Update appsettings.json
- [ ] Configure redirect URI
- [ ] Test OAuth flow
- [ ] Verify API connectivity

---

## Testing Endpoints

### Postman Collection Variables
```json
{
  "base_url": "https://your-api.com",
  "jira_base_url": "https://your-domain.atlassian.net",
  "jwt_token": "your-jwt-token",
  "jira_access_token": "jira-access-token",
  "client_id": "oauth-client-id",
  "client_secret": "oauth-client-secret",
  "redirect_uri": "https://your-app.com/oauth/callback"
}
```

---

## Troubleshooting

### Issue: "Invalid OAuth redirect URI"
**Solution:** Ensure redirect URI in request exactly matches OAuth app configuration

### Issue: "User not found"
**Solution:** Use account ID (e.g., `557058:f1c1a5b8-...`), not email

### Issue: "Invalid JQL"
**Solution:** URL encode JQL queries, test in Jira UI first

### Issue: "Worklog not created"
**Solution:** Ensure time is in seconds, date format is correct

### Issue: Token expired
**Solution:** Implement token refresh logic:
```csharp
if (tokenExpiry < DateTime.UtcNow.AddMinutes(5))
{
    // Refresh token
}
```

---

## Support

- **Jira API Docs:** https://developer.atlassian.com/cloud/jira/platform/rest/v3/
- **OAuth Guide:** https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
- **JQL Reference:** https://support.atlassian.com/jira-software-cloud/docs/what-is-advanced-searching-in-jira-cloud/

---

**Last Updated:** 2024-01-15
