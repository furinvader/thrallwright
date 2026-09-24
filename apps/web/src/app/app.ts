import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatToolbarModule } from '@angular/material/toolbar';
import { WorkbenchConnection } from './workbench-connection';

@Component({
  selector: 'app-root',
  imports: [MatButtonModule, MatCardModule, MatToolbarModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly connection = inject(WorkbenchConnection);
  protected readonly snapshot = this.connection.snapshot;
  protected readonly backendState = this.connection.state;
  protected readonly problem = this.connection.problem;
  protected readonly integrationLabel = computed(() => {
    if (this.backendState() !== 'connected')
      return 'Unknown while disconnected';
    const state = this.snapshot()?.integration.state;
    switch (state) {
      case 'available':
        return 'Available';
      case 'unavailable':
        return 'Unavailable';
      case 'connecting':
        return 'Connecting';
      default:
        return 'Checking';
    }
  });
}
