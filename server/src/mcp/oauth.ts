import { Response } from "express";
import { randomUUID } from "crypto";
import {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { verifyPassword } from "../admin/auth";
import { getConsentHTML } from "./oauth-consent";

// --- In-memory stores ---

interface AuthCode {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

interface TokenData {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

interface RefreshTokenData {
  clientId: string;
  scopes: string[];
  resource?: URL;
}

const AUTH_CODE_TTL = 10 * 60 * 1000; // 10 minutes
const ACCESS_TOKEN_TTL = 60 * 60 * 1000; // 1 hour

// --- Clients store ---

class WactlClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): Promise<OAuthClientInformationFull> {
    const full = client as OAuthClientInformationFull;
    this.clients.set(full.client_id, full);
    return full;
  }
}

// --- OAuth provider ---

export class WactlOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: WactlClientsStore;
  private codes = new Map<string, AuthCode>();
  private tokens = new Map<string, TokenData>();
  private refreshTokens = new Map<string, RefreshTokenData>();
  private adminPasswordHash: string;

  constructor(adminPasswordHash: string) {
    this.clientsStore = new WactlClientsStore();
    this.adminPasswordHash = adminPasswordHash;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Check if this is a form submission (POST with password)
    const body = (res.req as any)?.body;
    const password = body?.password as string | undefined;

    if (password) {
      // Form submission — validate password
      const valid = await verifyPassword(password, this.adminPasswordHash);
      if (!valid) {
        // Re-render form with error
        res.status(200).type("html").send(getConsentHTML({
          clientName: client.client_name || client.client_id,
          clientUri: client.client_uri,
          error: "Invalid password. Please try again.",
          // Pass OAuth params back to the form
          clientId: client.client_id,
          redirectUri: params.redirectUri,
          state: params.state,
          codeChallenge: params.codeChallenge,
          scopes: params.scopes,
          resource: params.resource?.toString(),
        }));
        return;
      }

      // Password valid — generate auth code and redirect
      const code = randomUUID();
      this.codes.set(code, {
        clientId: client.client_id,
        params,
        expiresAt: Date.now() + AUTH_CODE_TTL,
      });

      const targetUrl = new URL(params.redirectUri);
      targetUrl.searchParams.set("code", code);
      if (params.state) {
        targetUrl.searchParams.set("state", params.state);
      }
      res.redirect(302, targetUrl.toString());
      return;
    }

    // Initial GET — render consent form
    res.status(200).type("html").send(getConsentHTML({
      clientName: client.client_name || client.client_id,
      clientUri: client.client_uri,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes,
      resource: params.resource?.toString(),
    }));
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) {
      throw new Error("Invalid authorization code");
    }
    return codeData.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string
  ): Promise<OAuthTokens> {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) {
      throw new Error("Invalid authorization code");
    }
    if (codeData.clientId !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }
    if (Date.now() > codeData.expiresAt) {
      this.codes.delete(authorizationCode);
      throw new Error("Authorization code has expired");
    }

    this.codes.delete(authorizationCode);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const scopes = codeData.params.scopes || [];

    this.tokens.set(accessToken, {
      clientId: client.client_id,
      scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL,
      resource: codeData.params.resource,
    });

    this.refreshTokens.set(refreshToken, {
      clientId: client.client_id,
      scopes,
      resource: codeData.params.resource,
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[]
  ): Promise<OAuthTokens> {
    const data = this.refreshTokens.get(refreshToken);
    if (!data) {
      throw new Error("Invalid refresh token");
    }
    if (data.clientId !== client.client_id) {
      throw new Error("Refresh token was not issued to this client");
    }

    // Rotate refresh token
    this.refreshTokens.delete(refreshToken);
    const newAccessToken = randomUUID();
    const newRefreshToken = randomUUID();
    const tokenScopes = scopes || data.scopes;

    this.tokens.set(newAccessToken, {
      clientId: client.client_id,
      scopes: tokenScopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL,
      resource: data.resource,
    });

    this.refreshTokens.set(newRefreshToken, {
      clientId: client.client_id,
      scopes: tokenScopes,
      resource: data.resource,
    });

    return {
      access_token: newAccessToken,
      token_type: "bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL / 1000),
      refresh_token: newRefreshToken,
      scope: tokenScopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const data = this.tokens.get(token);
    if (!data) {
      throw new Error("Invalid or expired token");
    }
    if (Date.now() > data.expiresAt) {
      this.tokens.delete(token);
      throw new Error("Token has expired");
    }

    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: Math.floor(data.expiresAt / 1000),
      resource: data.resource,
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    this.tokens.delete(request.token);
    this.refreshTokens.delete(request.token);
  }
}
