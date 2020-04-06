import { LoggerService } from '@plopdown/logger';
import { Track } from '@plopdown/tracks';
import { bounceIn } from 'ng-animate';
import {
  Observable,
  Subject,
  ReplaySubject,
  combineLatest,
  BehaviorSubject,
  merge,
  fromEvent,
  animationFrameScheduler
} from 'rxjs';
import {
  Component,
  Input,
  ChangeDetectorRef,
  ChangeDetectionStrategy,
  ViewEncapsulation
} from '@angular/core';
import {
  map,
  switchMap,
  debounceTime,
  mapTo,
  tap,
  distinct,
  shareReplay,
  startWith
} from 'rxjs/operators';
import {
  trigger,
  transition,
  useAnimation,
  sequence,
  style,
  animate
} from '@angular/animations';
import { PlopdownCue } from '@plopdown/plopdown-cues';

@Component({
  selector: 'plopdown-video-overlay',
  templateUrl: './video-overlay.component.html',
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['./video-overlay.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    trigger('videoOutline', [
      transition(
        'void => *',
        sequence([
          style({
            'box-shadow': 'inset 0 0 0 3px lightgreen',
            'background-color': 'rgb(144, 238, 144, 0.2)'
          }),
          useAnimation(bounceIn, {
            params: { timing: 0.4 }
          }),
          animate(
            '1s',
            style({
              'box-shadow': 'inset 0 0 0 3px transparent',
              'background-color': 'transparent'
            })
          )
        ])
      )
    ])
  ]
})
export class VideoOverlayComponent {
  private manualReposition$: Subject<void> = new BehaviorSubject(null);
  private videoElem$: Subject<HTMLVideoElement> = new ReplaySubject(1);
  private track$: Subject<Track> = new ReplaySubject(1);

  public cues$: Observable<PlopdownCue[]>;
  public styles$: Observable<{ overlay: object; stage: object }>;

  @Input() public set videoElem(elem: HTMLVideoElement | null) {
    if (elem) {
      this.videoElem$.next(elem);
    }
  }

  @Input() public set track(track: Track) {
    console.log(track);
    if (track) {
      this.track$.next(track);
    }
  }

  constructor(cd: ChangeDetectorRef, private logger: LoggerService) {
    const metadataTrack$ = combineLatest([this.videoElem$, this.track$]).pipe(
      switchMap(([elem, track]) => {
        return new Observable<TextTrack>(observer => {
          console.log('yep', track);
          const metadataTrack: TextTrack = elem.addTextTrack(
            'metadata',
            track.id,
            track.language
          );
          try {
            this.bindCues(metadataTrack, track);
          } catch (err) {
            console.error('nope', err);
          }
          metadataTrack.mode = 'showing';
          observer.next(metadataTrack);

          return () => {
            metadataTrack.mode = 'disabled';
          };
        });
      }),
      shareReplay(1)
    );

    this.cues$ = metadataTrack$.pipe(
      switchMap(track => {
        return fromEvent(track, 'cuechange').pipe(
          startWith(track),
          mapTo(track.activeCues)
        );
      }),
      map(cueList => {
        return this.cueListToArray(cueList);
      }),
      shareReplay(1),
      tap(cues => {
        setTimeout(() => {
          cd.detectChanges();
        }, 0);
      })
    );

    const positionOverlay$ = this.videoElem$.pipe(
      switchMap(elem => {
        return merge([
          this.manualReposition$.asObservable(),
          fromEvent(elem, 'play'),
          fromEvent(elem, 'load'),
          fromEvent(elem, 'resize'),
          fromEvent(elem, 'mousemove')
        ]).pipe(mapTo(elem));
      }),
      debounceTime(200, animationFrameScheduler)
    );

    const aspectRatio$ = positionOverlay$.pipe(
      map(elem => {
        return elem.videoWidth / elem.videoHeight;
      }),
      distinct()
    );

    const letterboxedWidth$ = combineLatest([
      positionOverlay$,
      aspectRatio$
    ]).pipe(
      map(([elem, aspectRatio]) => {
        if (elem.offsetWidth <= elem.offsetHeight * aspectRatio) {
          return elem.offsetWidth;
        }
        return elem.offsetHeight * aspectRatio;
      }),
      distinct()
    );

    const letterboxedHeight$ = combineLatest([
      positionOverlay$,
      aspectRatio$
    ]).pipe(
      map(([elem, aspectRatio]) => {
        if (elem.offsetWidth <= elem.offsetHeight * aspectRatio) {
          return elem.offsetWidth / aspectRatio;
        }
        return elem.offsetHeight;
      }),
      distinct()
    );

    const fontSize$ = positionOverlay$.pipe(
      map(elem => {
        return elem.offsetHeight / 44;
      }),
      distinct()
    );

    const overlayStyle$ = combineLatest([positionOverlay$, fontSize$]).pipe(
      map(([elem, fontSize]) => {
        return {
          'width.px': elem.offsetWidth,
          'height.px': elem.offsetHeight,
          'left.px': elem.offsetLeft,
          'top.px': elem.offsetTop,
          'font-size.px': fontSize
        };
      })
    );

    const stageStyle$ = combineLatest([
      letterboxedWidth$,
      letterboxedHeight$
    ]).pipe(
      map(([width, height]) => {
        return {
          'width.px': width,
          'height.px': height
        };
      })
    );

    this.styles$ = combineLatest([overlayStyle$, stageStyle$]).pipe(
      map(([overlay, stage]) => {
        return { overlay, stage };
      }),
      tap(() =>
        setTimeout(() => {
          cd.detectChanges();
        }, 0)
      )
    );
  }

  private bindCues(metadataTrack: TextTrack, storedTrack: Track) {
    storedTrack.cues.forEach(cue => {
      const trackCue = new VTTCue(
        cue.startTime,
        cue.endTime,
        JSON.stringify(cue.data)
      );
      if (cue.id) {
        trackCue.id = cue.id;
      }
      metadataTrack.addCue(trackCue);
    });
  }

  private cueListToArray(cueList: TextTrackCueList): PlopdownCue[] {
    const cues: PlopdownCue[] = [];

    for (let index = 0; index < cueList.length; index++) {
      const raw_cue = cueList[index];

      let id = raw_cue.id;
      if (raw_cue.id.length < 1) {
        id = index.toString();
      }

      let data: null | PlopdownCue['data'] = null;
      try {
        data = JSON.parse(raw_cue.text);
      } catch (err) {
        this.logger.error('Could not parse Cue JSON', err);
      }

      cues.push({
        startTime: raw_cue.startTime,
        endTime: raw_cue.endTime,
        id,
        data
      });
    }

    return cues;
  }
}
