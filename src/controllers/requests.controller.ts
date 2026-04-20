/**
 * Requests Controller
 * Handles time-off request lifecycle endpoints
 */

import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { RequestService } from '../services/request.service';
import { SubmitRequestInput, ApproveRequestInput, ConfirmRequestInput } from '../models/types';

@Controller('api/requests')
export class RequestsController {
  constructor(private requestService: RequestService) {}

  /**
   * Submit a time-off request
   * POST /api/requests
   */
  @Post()
  async submitRequest(@Body() input: SubmitRequestInput) {
    const request = await this.requestService.submitRequest({
      employeeId: input.employeeId,
      locationId: input.locationId,
      balanceType: input.balanceType,
      daysRequested: input.daysRequested
    });

    return {
      requestId: request.id,
      status: request.status,
      currentBalance: request.requestedBalanceAtSubmission
    };
  }

  /**
   * Manager approves a request
   * POST /api/requests/{requestId}/approve
   */
  @Post(':requestId/approve')
  async approveRequest(
    @Param('requestId') requestId: string,
    @Body() input: ApproveRequestInput
  ) {
    const request = await this.requestService.approveRequest(
      requestId,
      input.managerId,
      input.managerLocationId
    );

    // If divergence detected and pending employee confirmation, include divergence details
    if (request.status === 'pending_employee_confirmation') {
      return {
        requestId: request.id,
        status: request.status,
        divergence: {
          detected: true,
          reason: request.divergenceReason
        }
      };
    }

    return {
      requestId: request.id,
      status: request.status
    };
  }

  /**
   * Employee confirms request after divergence
   * POST /api/requests/{requestId}/confirm
   *
   * In production, employeeId would come from JWT auth token
   */
  @Post(':requestId/confirm')
  async confirmRequest(
    @Param('requestId') requestId: string,
    @Body() input: ConfirmRequestInput
  ) {
    // TODO: Extract employeeId from JWT auth token
    const employeeId = 'E001'; // Placeholder - extract from auth context

    const request = await this.requestService.confirmRequest(
      requestId,
      employeeId,
      input.action
    );

    return {
      requestId: request.id,
      status: request.status
    };
  }

  /**
   * Get request status
   * GET /api/requests/{requestId}
   */
  @Get(':requestId')
  async getRequestStatus(@Param('requestId') requestId: string) {
    const request = await this.requestService.getRequestStatus(requestId);

    return {
      requestId: request.id,
      status: request.status,
      employeeId: request.employeeId,
      locationId: request.locationId,
      balanceType: request.balanceType,
      daysRequested: request.daysRequested,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      approvedAt: request.hcmApprovedAt,
      divergence: request.divergenceDetectedAt ? {
        detected: true,
        reason: request.divergenceReason
      } : undefined
    };
  }
}
